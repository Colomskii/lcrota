import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  setDoc,
  deleteDoc,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCrv2k5emjrgzDtOLMnnwlda1erTwbm1f0",
  authDomain: "rota-webapp.firebaseapp.com",
  projectId: "rota-webapp",
  storageBucket: "rota-webapp.firebasestorage.app",
  messagingSenderId: "50189472999",
  appId: "1:50189472999:web:e712bcd6f8bac70c7bbe42",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

function addOneDay(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + 1);

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getDate()).padStart(2, "0")}`;
}

async function fixWeeks() {
  const weeksSnap = await getDocs(collection(db, "rotaWeeks"));

  for (const weekDoc of weeksSnap.docs) {
    const oldId = weekDoc.id;
    const data = weekDoc.data();

    const [year, month, day] = oldId.split("-").map(Number);
    const date = new Date(year, month - 1, day);

    if (date.getDay() !== 0) {
      console.log(`Skipping non-Sunday week: ${oldId}`);
      continue;
    }

    const newId = addOneDay(oldId);

    console.log(`Moving ${oldId} → ${newId}`);

    await setDoc(doc(db, "rotaWeeks", newId), {
      ...data,
      weekStart: newId,
    });

    const overridesSnap = await getDocs(
      collection(db, "rotaWeeks", oldId, "overrides")
    );

    for (const overrideDoc of overridesSnap.docs) {
      await setDoc(
        doc(db, "rotaWeeks", newId, "overrides", overrideDoc.id),
        overrideDoc.data()
      );

      await deleteDoc(
        doc(db, "rotaWeeks", oldId, "overrides", overrideDoc.id)
      );
    }

    await deleteDoc(doc(db, "rotaWeeks", oldId));
  }

  console.log("Finished fixing Sunday week starts to Monday.");
}

fixWeeks().catch(console.error);