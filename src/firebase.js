
import { initializeApp } from "firebase/app";
import { initializeFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCrv2k5emjrgzDtOLMnnwlda1erTwbm1f0",
  authDomain: "rota-webapp.firebaseapp.com",
  projectId: "rota-webapp",
  storageBucket: "rota-webapp.firebasestorage.app",
  messagingSenderId: "50189472999",
  appId: "1:50189472999:web:e712bcd6f8bac70c7bbe42"
};

const app = initializeApp(firebaseConfig);

// Safari/WebKit 26.4+ can intermittently stall Firestore reads.
// Force long-polling for Apple WebKit browsers while retaining
// the standard Firestore connection for other browsers.

function needsWebKitLongPolling() {
  if (typeof navigator === "undefined") return false;

  const ua = navigator.userAgent || "";

  const isIOS =
    /iPad|iPhone|iPod/i.test(ua) ||
    (navigator.platform === "MacIntel" &&
      navigator.maxTouchPoints > 1);

  const isMacSafari =
    /Macintosh/i.test(ua) &&
    /Safari\//i.test(ua) &&
    !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR/i.test(ua);

  return isIOS || isMacSafari;
}

// Firestore settings must be configured before any database reads.
export const db = initializeFirestore(
  app,
  needsWebKitLongPolling()
    ? { experimentalForceLongPolling: true }
    : {}
);

export const auth = getAuth(app);
