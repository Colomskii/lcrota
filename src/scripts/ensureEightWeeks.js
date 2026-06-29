import { initializeApp } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCrv2k5emjrgzDtOLMnnwlda1erTwbm1f0",
  authDomain: "rota-webapp.firebaseapp.com",
  projectId: "rota-webapp",
  storageBucket: "rota-webapp.firebasestorage.app",
  messagingSenderId: "50189472999",
  appId: "1:50189472999:web:e712bcd6f8bac70c7bbe42"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

function getMonday(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay(); // Sunday = 0, Monday = 1
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addWeeks(date, weeks) {
  const d = new Date(date);
  d.setDate(d.getDate() + weeks * 7);
  return d;
}

function toDateId(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

async function ensureEightWeeks() {
  const currentMonday = getMonday();

  for (let i = 0; i < 8; i++) {
    const weekDate = addWeeks(currentMonday, i);
    const weekId = toDateId(weekDate);

    const weekRef = doc(db, "rotaWeeks", weekId);
    const existing = await getDoc(weekRef);

    if (existing.exists()) {
      console.log(`Already exists: ${weekId}`);
      continue;
    }

    await setDoc(weekRef, {
      weekStart: weekId,
      title: "LONGCROFT Staff Rota",
      status: "published",
      templateVersion: "originalPattern",
      createdBy: "system",
      createdAt: new Date().toISOString()
    });

    console.log(`Created: ${weekId}`);
  }

  console.log("Eight-week rota window checked.");
}

ensureEightWeeks().catch(console.error);