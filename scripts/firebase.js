const firebaseConfig = {
  apiKey: "AIzaSyANCpYHeLyWkgVtWL06xpI7XsP08xu9GPA",
  authDomain: "digilayn-projects.firebaseapp.com",
  projectId: "digilayn-projects",
  storageBucket: "digilayn-projects.firebasestorage.app",
  messagingSenderId: "95485356681",
  appId: "1:95485356681:web:3cf619a266961009e17458",
  measurementId: "G-27H9WZSCGQ"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
let analytics;
try {
  if (location.protocol !== 'file:') {
    analytics = firebase.analytics();
  }
} catch (e) {
  console.warn("Firebase Analytics could not be initialized:", e);
}

// Enable offline persistence with multi-tab support
if (location.protocol !== 'file:') {
  // Use a more robust check for Firestore before calling methods
  if (typeof firebase.firestore === 'function') {
    // Newer settings object to avoid deprecation warnings.
    // In SDK v9 compat, we use the older method but with settings if needed.
    // Actually, v9 compat STILL uses enablePersistence.
    db.enablePersistence({synchronizeTabs: true})
      .catch((err) => {
        if (err.code === 'failed-precondition') {
          console.warn('Firebase persistence failed: multiple tabs open.');
        } else if (err.code === 'unimplemented') {
          console.warn('Firebase persistence failed: browser does not support it.');
        }
      });
  }
}

