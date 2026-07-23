/**
 * observable.js — Minimal, framework-free reactive store (the "M" plumbing for MVVM).
 *
 * A Store holds a single immutable-ish state object and notifies subscribers
 * whenever it changes. Views (HTML pages) subscribe and re-render; ViewModels
 * own a Store and mutate it. No dependencies, no build step.
 *
 * Usage:
 *   const store = new Store({ count: 0 });
 *   const unsubscribe = store.subscribe(state => console.log(state.count));
 *   store.setState({ count: 1 });                 // object patch
 *   store.setState(prev => ({ count: prev.count + 1 })); // functional patch
 *   unsubscribe();
 */
(function (global) {
    'use strict';

    class Store {
        constructor(initialState = {}) {
            this._state = initialState;
            this._subscribers = new Set();
        }

        /** Returns the current state snapshot. */
        getState() {
            return this._state;
        }

        /**
         * Merge a patch into state and notify subscribers.
         * @param {object|function} patch Object to shallow-merge, or (prevState) => patch.
         */
        setState(patch) {
            const resolved = typeof patch === 'function' ? patch(this._state) : patch;
            this._state = Object.assign({}, this._state, resolved);
            this._notify();
        }

        /**
         * Subscribe to state changes.
         * @param {function} listener Called with the current state.
         * @param {{immediate?: boolean}} [options] immediate (default true) fires once now.
         * @returns {function} Unsubscribe function.
         */
        subscribe(listener, options) {
            const immediate = !options || options.immediate !== false;
            this._subscribers.add(listener);
            if (immediate) {
                this._safeInvoke(listener);
            }
            return () => this._subscribers.delete(listener);
        }

        _notify() {
            this._subscribers.forEach((listener) => this._safeInvoke(listener));
        }

        _safeInvoke(listener) {
            try {
                listener(this._state);
            } catch (err) {
                console.error('Store subscriber threw:', err);
            }
        }
    }

    global.Store = Store;
})(window);
