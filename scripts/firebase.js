/**
 * firebase.js — Universal Firebase Configuration & Initialization
 * 
 * Single source of truth for Firebase across the entire Poortjie & LaynFleet web app.
 * Exports db (Firestore), auth (Authentication), storage (Cloud Storage),
 * functions (Cloud Functions), and rtdb (Realtime Database).
 */
const firebaseConfig = {
  apiKey: "AIzaSyANCpYHeLyWkgVtWL06xpI7XsP08xu9GPA",
  authDomain: "digilayn-projects.firebaseapp.com",
  projectId: "digilayn-projects",
  storageBucket: "digilayn-projects.firebasestorage.app",
  messagingSenderId: "95485356681",
  appId: "1:95485356681:web:3cf619a266961009e17458",
  measurementId: "G-27H9WZSCGQ",
  // Realtime Database instance for Europe West (LaynFleet presence)
  databaseURL: "https://digilayn-projects-default-rtdb.europe-west1.firebasedatabase.app"
};

// Initialize Firebase once globally
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const db = firebase.firestore();
const auth = firebase.auth();
const storage = typeof firebase.storage === 'function' ? firebase.storage() : null;
const functions = typeof firebase.functions === 'function' ? firebase.app().functions('us-central1') : null;
const rtdb = typeof firebase.database === 'function' ? firebase.database() : null;

let analytics = null;
try {
  if (typeof firebase.analytics === 'function' && location.protocol !== 'file:') {
    analytics = firebase.analytics();
  }
} catch (e) {
  console.warn("Firebase Analytics could not be initialized:", e);
}

// Enable offline persistence with multi-tab support
if (location.protocol !== 'file:' && typeof firebase.firestore === 'function') {
  db.enablePersistence({ synchronizeTabs: true })
    .catch((err) => {
      if (err.code === 'failed-precondition') {
        console.warn('Firebase persistence warning: multiple tabs open.');
      } else if (err.code === 'unimplemented') {
        console.warn('Firebase persistence warning: browser does not support it.');
      }
    });
}


