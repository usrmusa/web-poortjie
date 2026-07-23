/**
 * auth-store.js — Global AuthStore (ViewModel) : the single source of truth
 * for login state across the entire web app.
 *
 * Any page includes this file and does:
 *
 *   AuthStore.subscribe(state => renderMyUI(state)); // react to changes
 *   AuthStore.init();                                // start listening once
 *
 * State shape:
 *   {
 *     status: 'loading' | 'authenticated' | 'unauthenticated',
 *     isAuthenticated: boolean,
 *     user: UserModel | null   // camelCase domain user (see user-model.js)
 *   }
 *
 * Behaviour / good practices baked in:
 *   - One Firestore read for the profile+roles, cached per session so the menu
 *     doesn't flicker on every navigation (user-friendly).
 *   - Optimistic hydrate from sessionStorage for instant UI, then reconciled
 *     with the live Auth + Firestore data.
 *   - init() is idempotent — safe to call from every page.
 */
(function (global) {
    'use strict';

    const CACHE_KEY = 'authUserCache';

    const store = new global.Store({
        status: 'loading',
        isAuthenticated: false,
        user: null
    });

    let initialized = false;

    function readCache() {
        try {
            const raw = sessionStorage.getItem(CACHE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (err) {
            return null;
        }
    }

    function writeCache(user) {
        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify(user));
        } catch (err) {
            /* storage full / unavailable — non-fatal */
        }
    }

    function clearCache() {
        try {
            sessionStorage.removeItem(CACHE_KEY);
        } catch (err) {
            /* ignore */
        }
    }

    /** Idempotent: wires the Firebase auth listener exactly once. */
    function init() {
        if (initialized) return store;
        initialized = true;

        // Optimistic UI: show cached user immediately while Firebase resolves.
        const cached = readCache();
        if (cached) {
            store.setState({ status: 'authenticated', isAuthenticated: true, user: cached });
        }

        firebase.auth().onAuthStateChanged(async (authUser) => {
            if (!authUser) {
                clearCache();
                store.setState({ status: 'unauthenticated', isAuthenticated: false, user: null });
                return;
            }

            // 1) Immediate state from the Auth record (no roles yet).
            let user = global.UserModel.fromFirestore(authUser, null);
            store.setState({ status: 'authenticated', isAuthenticated: true, user });

            // 2) Enrich with the Firestore profile + roles.
            try {
                const doc = await firebase.firestore().collection('users').doc(authUser.uid).get();
                user = global.UserModel.fromFirestore(authUser, doc.exists ? doc.data() : null);
                store.setState({ user });
                writeCache(user);
            } catch (err) {
                console.error('AuthStore: failed to load user profile', err);
            }
        });

        return store;
    }

    /** Sign in with email/password. Resolves with the Firebase UserCredential. */
    function signIn(email, password) {
        return firebase.auth().signInWithEmailAndPassword(email, password);
    }

    /** Sign out and clear cached state. */
    async function signOut() {
        clearCache();
        return firebase.auth().signOut();
    }

    const subscribe = (listener, options) => store.subscribe(listener, options);
    const getState = () => store.getState();

    global.AuthStore = { init, subscribe, getState, signIn, signOut };
})(window);
