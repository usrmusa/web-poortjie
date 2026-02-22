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

// Connect to Firebase Emulators if running locally
if (location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname.startsWith("192.168.") ||
    location.hostname.startsWith("10.") ||
    location.hostname.endsWith(".local")) {
  const host = location.hostname;
  console.log(`Connecting to Firebase Emulators at ${host}...`);
  db.useEmulator(host, 8080);
  auth.useEmulator(`http://${host}:9099`);
  if (typeof firebase.storage === 'function') {
    firebase.storage().useEmulator(host, 9199);
  }
}

// Enable offline persistence with multi-tab support
if (location.protocol !== 'file:') {
// For Firebase JS SDK v9 compat, multi-tab persistence is enabled by default if available.
  // Using the newer settings object to avoid deprecation warnings.
  db.enablePersistence({synchronizeTabs: true})
    .catch((err) => {
      if (err.code === 'failed-precondition') {
        // This can still happen if multiple tabs are open with different persistence settings.
        console.warn('Firebase persistence failed: multiple tabs open with different settings.');
      } else if (err.code === 'unimplemented') {
        // The current browser does not support all of the features required to enable persistence.
        console.warn('Firebase persistence failed: browser does not support it.');
      }
    });
}

/**
 * Logs a user trace (login or register event) to Firestore.
 * @param {string} uid - The user's Firebase UID.
 */
async function logUserTrace(uid) {
  try {
    await db.collection('user_traces').doc(uid).set({
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      browser: navigator.userAgent
    }, { merge: true });
  } catch (error) {
    console.error('Error logging user trace:', error);
  }
}
