/**
 * firebase-config.js — LaynFleet Rider Web Client.
 *
 * Uses the shared Digilayn Firebase project (`digilayn-projects`) — the same
 * backend the Android apps (LaynRider / LaynDriver) and the manager dashboard use.
 */
(function (global) {
  'use strict';

  global.LAYNFLEET_FIREBASE_CONFIG = {
    apiKey: 'AIzaSyANCpYHeLyWkgVtWL06xpI7XsP08xu9GPA',
    authDomain: 'digilayn-projects.firebaseapp.com',
    projectId: 'digilayn-projects',
    storageBucket: 'digilayn-projects.firebasestorage.app',
    messagingSenderId: '95485356681',
    appId: '1:95485356681:web:3cf619a266961009e17458',
    measurementId: 'G-27H9WZSCGQ'
  };

  // Firestore layout (must match Android app & Manager — camelCase, app-first).
  global.FS = {
    users: 'users',
    laynfleet: 'laynfleet',
    laynfleetDoc: 'main',
    drivers: 'drivers',
    riders: 'riders',
    bookings: 'bookings',
    adminActions: 'adminActions'
  };

  // Poortjie service area boundary (locked).
  global.SERVICE_AREA = {
    center: { lat: -26.45600, lng: 27.77087 },
    radiusMeters: 1637 // ~1.64 km
  };

  // Provenance string for rider app.
  global.APP_PACKAGE = 'com.digilayn.laynrider';
})(window);
