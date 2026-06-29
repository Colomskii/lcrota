import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc } from "firebase/firestore";

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

const shifts = [
  // MONDAY
  { day: "Monday", dayIndex: 1, shift: "Manager 9-5", sortOrder: 1, staff: ["C McMillan"], active: true },
  { day: "Monday", dayIndex: 1, shift: "9am-5pm", sortOrder: 2, staff: ["L Bennett", "K Sandbrook"], active: true },
  { day: "Monday", dayIndex: 1, shift: "5pm-10pm", sortOrder: 3, staff: ["J Sandbrook"], active: true },
  { day: "Monday", dayIndex: 1, shift: "10pm-9am", sortOrder: 4, staff: ["J Sandbrook"], active: true },

  // TUESDAY
  { day: "Tuesday", dayIndex: 2, shift: "Manager 9-5", sortOrder: 1, staff: ["C McMillan"], active: true },
  { day: "Tuesday", dayIndex: 2, shift: "9am-5pm", sortOrder: 2, staff: ["L Bennett", "K Sandbrook"], active: true },
  { day: "Tuesday", dayIndex: 2, shift: "5pm-10pm", sortOrder: 3, staff: ["J Sandbrook"], active: true },
  { day: "Tuesday", dayIndex: 2, shift: "10pm-9am", sortOrder: 4, staff: ["J Sandbrook"], active: true },

  // WEDNESDAY
  { day: "Wednesday", dayIndex: 3, shift: "Manager 9-5", sortOrder: 1, staff: ["C McMillan"], active: true },
  { day: "Wednesday", dayIndex: 3, shift: "9am-5pm", sortOrder: 2, staff: ["C Aldridge", "B Imionayi"], active: true },
  { day: "Wednesday", dayIndex: 3, shift: "5pm-10pm", sortOrder: 3, staff: ["C Aldridge"], active: true },
  { day: "Wednesday", dayIndex: 3, shift: "10pm-9am", sortOrder: 4, staff: ["J Sandbrook"], active: true },

  // THURSDAY
  { day: "Thursday", dayIndex: 4, shift: "Manager 9-5", sortOrder: 1, staff: ["C McMillan"], active: true },
  { day: "Thursday", dayIndex: 4, shift: "9am-5pm", sortOrder: 2, staff: ["K Sandbrook", "C Aldridge"], active: true },
  { day: "Thursday", dayIndex: 4, shift: "5pm-10pm", sortOrder: 3, staff: ["M Simon"], active: true },
  { day: "Thursday", dayIndex: 4, shift: "10pm-9am", sortOrder: 4, staff: ["M Simon"], active: true },

  // FRIDAY
  { day: "Friday", dayIndex: 5, shift: "Manager 9-5", sortOrder: 1, staff: ["C McMillan"], active: true },
  { day: "Friday", dayIndex: 5, shift: "9am-5pm", sortOrder: 2, staff: ["S Crossley", "J Jarvis"], active: true },
  { day: "Friday", dayIndex: 5, shift: "5pm-10pm", sortOrder: 3, staff: ["M Simon"], active: true },
  { day: "Friday", dayIndex: 5, shift: "10pm-9am", sortOrder: 4, staff: ["M Simon"], active: true },

  // SATURDAY
  { day: "Saturday", dayIndex: 6, shift: "Manager 9-5", sortOrder: 1, staff: [], active: true },
  { day: "Saturday", dayIndex: 6, shift: "9am-5pm", sortOrder: 2, staff: ["C Aldridge", "B Imionayi"], active: true },
  { day: "Saturday", dayIndex: 6, shift: "5pm-10pm", sortOrder: 3, staff: ["M Simon"], active: true },
  { day: "Saturday", dayIndex: 6, shift: "10pm-9am", sortOrder: 4, staff: ["M Simon"], active: true },

  // SUNDAY
  { day: "Sunday", dayIndex: 7, shift: "Manager 9-5", sortOrder: 1, staff: [], active: true },
  { day: "Sunday", dayIndex: 7, shift: "9am-5pm", sortOrder: 2, staff: ["B Imionayi", "S Boyling"], active: true },
  { day: "Sunday", dayIndex: 7, shift: "5pm-10pm", sortOrder: 3, staff: ["J Sandbrook"], active: true },
  { day: "Sunday", dayIndex: 7, shift: "10pm-9am", sortOrder: 4, staff: ["J Sandbrook"], active: true }
];

async function seedBaseTemplate() {
  const shiftsRef = collection(
    db,
    "baseTemplate",
    "originalPattern",
    "shifts"
  );

  for (const shift of shifts) {
    await addDoc(shiftsRef, shift);
    console.log(`Added ${shift.day} - ${shift.shift}`);
  }

  console.log("Base rota uploaded successfully.");
}

seedBaseTemplate().catch(console.error);