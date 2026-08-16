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
                let doc = await firebase.firestore().collection('users').doc(authUser.uid).get();
                if (!doc.exists) {
                    await ensureUserDoc(authUser);
                    doc = await firebase.firestore().collection('users').doc(authUser.uid).get();
                }
                user = global.UserModel.fromFirestore(authUser, doc.exists ? doc.data() : null);
                store.setState({ user });
                writeCache(user);
            } catch (err) {
                console.error('AuthStore: failed to load user profile', err);
            }
        });

        return store;
    }

    /** Ensures the user's Firestore document exists upon Google Sign-In or initial auth */
    async function ensureUserDoc(authUser) {
        if (!authUser || !authUser.uid) return null;
        try {
            const userRef = firebase.firestore().collection('users').doc(authUser.uid);
            const doc = await userRef.get();
            if (!doc.exists) {
                let baseUsername = (authUser.email ? authUser.email.split('@')[0] : (authUser.displayName || 'user'))
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, '');
                if (!baseUsername) baseUsername = 'user' + Math.floor(1000 + Math.random() * 9000);

                let finalUsername = baseUsername;
                try {
                    const usernameDoc = await firebase.firestore().collection('usernames').doc(finalUsername).get();
                    if (usernameDoc.exists) {
                        finalUsername = `${baseUsername}${Math.floor(100 + Math.random() * 900)}`;
                    }
                    await firebase.firestore().collection('usernames').doc(finalUsername).set({
                        userId: authUser.uid,
                        lockedUntil: null
                    }, { merge: true });
                } catch (e) {
                    console.warn('AuthStore: error reserving username', e);
                }

                const newDocData = {
                    userId: authUser.uid,
                    username: finalUsername,
                    displayName: authUser.displayName || finalUsername,
                    email: authUser.email || '',
                    emailVerified: authUser.emailVerified || false,
                    phone: authUser.phoneNumber || '',
                    photoUrl: authUser.photoURL || null,
                    registeredWith: 'com.digilayn.web',
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    lastActive: firebase.firestore.FieldValue.serverTimestamp(),
                    devices: {}
                };
                await userRef.set(newDocData, { merge: true });
                return newDocData;
            } else {
                await userRef.set({
                    lastActive: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true }).catch(() => {});
                return doc.data();
            }
        } catch (err) {
            console.warn('AuthStore: failed ensuring user doc', err);
            return null;
        }
    }

    /** Sign in with Google (Popup with fallback to redirect). */
    async function signInWithGoogle() {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        try {
            const result = await firebase.auth().signInWithPopup(provider);
            if (result && result.user) {
                await ensureUserDoc(result.user);
            }
            return result;
        } catch (err) {
            if (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request') {
                return firebase.auth().signInWithRedirect(provider);
            }
            throw err;
        }
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

    global.AuthStore = { init, subscribe, getState, signIn, signInWithGoogle, signOut, ensureUserDoc };
})(window);
