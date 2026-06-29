import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
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

export const db = getFirestore(app);
export const auth = getAuth(app);