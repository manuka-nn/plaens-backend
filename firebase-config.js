/*
 * Firebase settings for PLAENS
 * ----------------------------
 * These values come from your Firebase project "plaens-backend".
 *
 * They are safe to publish on GitHub: they identify your project, they don't
 * grant access to it. Your data is protected by the sign-in and by the
 * Firestore rules (see firestore.rules and the README).
 *
 * To go back to saving data in this browser only, set enabled to false.
 */
window.PLAENS_FIREBASE = {
  enabled: true,

  config: {
    apiKey: 'AIzaSyBBi6vASmVTaMbvni7UBc6sdh6ZipFt0rg',
    authDomain: 'plaens-backend.firebaseapp.com',
    projectId: 'plaens-backend',
    storageBucket: 'plaens-backend.firebasestorage.app',
    messagingSenderId: '428905738543',
    appId: '1:428905738543:web:0138b04747493c760431da',
  },

  // Name of the store inside your database. Keep this the same on every device.
  storeId: 'plaens',
};
