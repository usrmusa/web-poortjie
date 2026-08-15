/**
 * user-model.js — Domain Model for an authenticated user.
 *
 * Direct camelCase mapping matching the Android LaynFleet schema and Firestore.
 *
 * Firestore fields (strict camelCase):
 *   displayName, photoUrl, phone, bio, roles, email, registeredWith, createdAt, updatedAt
 *
 * Domain object (camelCase) exposed to Views/ViewModels:
 *   { uid, email, displayName, photoUrl, phoneNumber, bio, profile, roles }
 *   roles => { isSuperUser, isPoortjieAdmin, isTaxiRankAdmin, listForSupport }
 */
(function (global) {
    'use strict';

    /**
     * Build the camelCase domain user from an Auth user and its Firestore doc.
     * @param {object|null} authUser Firebase Auth user (or null).
     * @param {object|null} docData  Raw Firestore users/{uid} data (camelCase) or null.
     */
    function fromFirestore(authUser, docData) {
        const profile = docData || {};
        const roles = profile.roles || {};
        const digilayn = roles.digilayn || {};
        const poortjie = roles.poortjie || {};

        return {
            uid: (authUser && authUser.uid) || null,
            email: (authUser && authUser.email) || profile.email || null,
            displayName: profile.displayName || (authUser && authUser.displayName) || '',
            photoUrl: profile.photoUrl || (authUser && authUser.photoURL) || '',
            phoneNumber: profile.phone || (authUser && authUser.phoneNumber) || '',
            bio: profile.bio || '',
            profile,
            roles: {
                isSuperUser: digilayn.isSuperUser === true,
                isPoortjieAdmin: poortjie.isAdmin === true,
                isTaxiRankAdmin: poortjie.isTaxiRankAdmin === true,
                listForSupport: poortjie.listForSupport === true
            }
        };
    }

    /**
     * Convert a domain model for Firestore writes (strict camelCase).
     */
    function toFirestore(model) {
        return model;
    }

    global.UserModel = { fromFirestore, toFirestore };
})(window);
