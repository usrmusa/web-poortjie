/**
 * user-model.js — The "Model" in MVVM for an authenticated user.
 *
 * Normalizes the two sources of truth (Firebase Auth user + the Firestore
 * `users/{uid}` document, which is stored in snake_case) into ONE camelCase
 * domain object the whole web app can rely on.
 *
 * Firestore fields today (snake_case):
 *   display_name, photo_url, phone_number, bio,
 *   roles.digilayn.is_super_user,
 *   roles.poortjie.is_admin, roles.poortjie.is_taxi_rank_admin,
 *   roles.poortjie.list_for_support
 *
 * Domain object (camelCase) exposed to Views/ViewModels:
 *   { uid, email, displayName, photoUrl, phoneNumber, bio, profile, roles }
 *   roles => { isSuperUser, isPoortjieAdmin, isTaxiRankAdmin, listForSupport }
 */
(function (global) {
    'use strict';

    const { keysToCamel, keysToSnake } = global.CaseMapper;

    /**
     * Build the camelCase domain user from an Auth user and its Firestore doc.
     * @param {object|null} authUser Firebase Auth user (or null).
     * @param {object|null} docData  Raw Firestore users/{uid} data (snake_case) or null.
     */
    function fromFirestore(authUser, docData) {
        const profile = docData ? keysToCamel(docData) : {};
        const roles = profile.roles || {};
        const digilayn = roles.digilayn || {};
        const poortjie = roles.poortjie || {};

        return {
            uid: (authUser && authUser.uid) || null,
            email: (authUser && authUser.email) || profile.email || null,
            // Firestore profile is the preferred source; fall back to the Auth record.
            displayName: profile.displayName || (authUser && authUser.displayName) || '',
            photoUrl: profile.photoUrl || (authUser && authUser.photoURL) || '',
            phoneNumber: profile.phoneNumber || (authUser && authUser.phoneNumber) || '',
            bio: profile.bio || '',
            // Full normalized profile for any page that needs more fields.
            profile,
            // Flattened, intention-revealing role flags.
            roles: {
                isSuperUser: digilayn.isSuperUser === true,
                isPoortjieAdmin: poortjie.isAdmin === true,
                isTaxiRankAdmin: poortjie.isTaxiRankAdmin === true,
                listForSupport: poortjie.listForSupport === true
            }
        };
    }

    /**
     * Convert a camelCase domain/profile object back to the snake_case shape
     * used for Firestore writes. Use this when persisting profile edits.
     */
    function toFirestore(model) {
        return keysToSnake(model);
    }

    global.UserModel = { fromFirestore, toFirestore };
})(window);
