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
    measurementId: 'G-27H9WZSCGQ',
    // Realtime Database (driver presence). Instance is europe-west1 — must be
    // set explicitly or the SDK defaults to the wrong (us-central) URL.
    databaseURL: 'https://digilayn-projects-default-rtdb.europe-west1.firebasedatabase.app'
  };

  // Cloud Functions region — MUST match the deployed dispatch functions and the
  // Android DispatchGateway (FirebaseFunctions.getInstance("us-central1")).
  global.FUNCTIONS_REGION = 'us-central1';

  // Firestore layout (must match Android app & Manager — camelCase, app-first).
  global.FS = {
    users: 'users',
    laynfleet: 'laynfleet',
    laynfleetDoc: 'main',
    drivers: 'drivers',
    riders: 'riders',
    bookings: 'bookings',
    ratings: 'ratings',
    reviewLikes: 'reviewLikes',
    adminActions: 'adminActions'
  };

  // Realtime Database presence path + freshness window (mirrors Android
  // FirestoreDriverRepository: RTDB_LOCATIONS + HEARTBEAT_FRESHNESS_WINDOW_MS).
  global.RTDB_LOCATIONS = 'driverLocations';
  global.HEARTBEAT_FRESHNESS_WINDOW_MS = 60000; // 60s

  // Poortjie service area boundary (locked).
  global.SERVICE_AREA = {
    center: { lat: -26.45600, lng: 27.77087 },
    radiusMeters: 1637 // ~1.64 km
  };

  // Provenance string for rider app.
  global.APP_PACKAGE = 'com.digilayn.laynrider';
})(window);
