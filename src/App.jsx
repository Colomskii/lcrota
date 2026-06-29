import { useEffect, useRef, useState } from "react";
import {
  collection,
  getDocs,
  getDoc,
  query,
  orderBy,
  doc,
  setDoc,
  deleteDoc,
} from "firebase/firestore";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { db, auth } from "./firebase";
import "./App.css";
import lcMonogram from "./assets/lc-monogram.png";

const SHIFTS = ["Manager 9-5", "9am-5pm", "5pm-10pm", "10pm-9am"];

const DAYS = [
  { dayIndex: 1, name: "Monday" },
  { dayIndex: 2, name: "Tuesday" },
  { dayIndex: 3, name: "Wednesday" },
  { dayIndex: 4, name: "Thursday" },
  { dayIndex: 5, name: "Friday" },
  { dayIndex: 6, name: "Saturday" },
  { dayIndex: 7, name: "Sunday" },
];

function parseLocalDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(dateString, days) {
  const date = parseLocalDate(dateString);
  date.setDate(date.getDate() + days);
  return date;
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

function formatWeekCommencing(dateString) {
  return parseLocalDate(dateString).toLocaleDateString("en-GB");
}

function formatDayLabel(date) {
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
  });
}

function getCurrentMondayDate() {
  const date = new Date();
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);

  const monday = new Date(date);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);

  return monday;
}

function getCurrentMondayId() {
  return toDateId(getCurrentMondayDate());
}

function makeOverrideId(dayIndex, shift) {
  return `${dayIndex}_${shift.replaceAll(" ", "_").replaceAll("-", "_")}`;
}

function usernameToEmail(username) {
  const cleaned = username.trim().toLowerCase();

  if (cleaned === "user") return "viewer@longcroft.local";
  if (cleaned === "admin") return "editor@longcroft.local";

  return cleaned;
}

function handlePrint() {
  const printArea = document.querySelector(".rota-paper");

  if (!printArea) {
    alert("Could not find rota to print.");
    return;
  }

  const printWindow = window.open("", "_blank");

  if (!printWindow) {
    alert("Print was blocked. Please allow pop-ups for this site.");
    return;
  }

  printWindow.document.open();
  printWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>Longcroft Staffing Rota</title>
        <style>
          @page {
            size: A4 landscape;
            margin: 8mm;
          }

          html, body {
            margin: 0;
            padding: 0;
            background: white;
            color: #222;
            font-family: Arial, Helvetica, sans-serif;
          }

          .auth-bar,
          .week-nav,
          .week-select,
          .admin-tabs,
          .editor-panel,
          .print-button,
          .mobile-rota-days,
          .mobile-day-card,
          .mobile-shift-card,
          button,
          select,
          input,
          textarea {
            display: none !important;
          }

          .rota-paper {
            width: 100%;
            max-width: none;
            margin: 0;
            padding: 0;
            box-shadow: none;
            background: white;
          }

          .rota-header {
            text-align: center;
            margin: 0 0 6mm 0;
            padding: 0;
          }

          .rota-monogram {
            width: 55px !important;
            height: auto !important;
            margin: 0 auto 2mm auto !important;
            display: block;
          }

          .rota-header h1 {
            font-size: 24px;
            margin: 1mm 0;
            font-style: italic;
            text-decoration: underline;
            font-weight: 500;
          }

          .rota-header h2,
          .rota-header h3,
          .rota-header p {
            font-size: 14px;
            margin: 1mm 0;
            font-style: italic;
            text-decoration: underline;
            font-weight: 500;
          }

          .rota-table {
            display: table !important;
            width: 100% !important;
            table-layout: fixed !important;
            border-collapse: collapse !important;
            margin: 0 !important;
            background: white !important;
          }

          .rota-table th,
          .rota-table td {
            border: 1px solid #222 !important;
            padding: 7px !important;
            font-size: 12px !important;
            line-height: 1.25 !important;
            vertical-align: top !important;
            overflow-wrap: break-word !important;
            word-break: normal !important;
          }

          .rota-table td {
            height: 82px !important;
          }

          .rota-table thead th {
            text-align: center;
            font-weight: 700;
          }

          .rota-table tbody th {
            width: 105px !important;
            font-weight: 700;
          }

          .empty-cell,
          .vacant,
          .note {
            color: #000 !important;
          }

          .vacant {
            margin-top: 3px;
            font-weight: 700;
          }

          .note {
            margin-top: 2px;
            font-size: 10px;
          }
        </style>
      </head>
      <body>
        ${printArea.outerHTML}
        <script>
          setTimeout(function () {
            window.focus();
            window.print();
          }, 500);

          window.onafterprint = function () {
            window.close();
          };
        </script>
      </body>
    </html>
  `);
  printWindow.document.close();
}

function App() {
  const [weeks, setWeeks] = useState([]);
  const [selectedWeek, setSelectedWeek] = useState("");
  const [rota, setRota] = useState({});
  const [overrides, setOverrides] = useState({});
  const [adminView, setAdminView] = useState("weekly");
  const [editDayIndex, setEditDayIndex] = useState(1);
  const [editShift, setEditShift] = useState("9am-5pm");
  const [editStaffText, setEditStaffText] = useState("");
  const [editVacantSlots, setEditVacantSlots] = useState(0);
  const [editNote, setEditNote] = useState("");
  const [baseDayIndex, setBaseDayIndex] = useState(1);
  const [baseShift, setBaseShift] = useState("9am-5pm");
  const [baseStaffText, setBaseStaffText] = useState("");
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [overridesLoading, setOverridesLoading] = useState(false);
  const [loadedOverridesForWeek, setLoadedOverridesForWeek] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const logoutTimer = useRef(null);
  const warningTimer = useRef(null);
  const countdownInterval = useRef(null);
  const warningActive = useRef(false);
  const [showLogoutWarning, setShowLogoutWarning] = useState(false);
  const [countdown, setCountdown] = useState(30);
  const isEditor = user?.email === "editor@longcroft.local";
  const currentWeekId = getCurrentMondayId();

  const visibleWeeks = isEditor
    ? weeks
    : weeks.filter((week) => week.weekStart >= currentWeekId);

  async function loadWeeks() {
    const weeksQuery = query(collection(db, "rotaWeeks"), orderBy("weekStart"));
    const snapshot = await getDocs(weeksQuery);

    const loadedWeeks = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    setWeeks(loadedWeeks);
    return loadedWeeks;
  }

  async function ensureEightWeeks(existingWeeks = weeks) {
    const currentMonday = getCurrentMondayDate();

    const requiredWeeks = Array.from({ length: 8 }, (_, index) => {
      const weekDate = addWeeks(currentMonday, index);
      return toDateId(weekDate);
    });

    const existingWeekIds = new Set(
      existingWeeks.map((week) => week.weekStart || week.id)
    );

    const missingWeeks = requiredWeeks.filter(
      (weekId) => !existingWeekIds.has(weekId)
    );

    if (missingWeeks.length === 0) {
      return false;
    }

    await Promise.all(
      missingWeeks.map((weekId) =>
        setDoc(doc(db, "rotaWeeks", weekId), {
          weekStart: weekId,
          title: "LONGCROFT Staff Rota",
          status: "published",
          templateVersion: "originalPattern",
          createdBy: "admin-login-check",
          createdAt: new Date().toISOString(),
        })
      )
    );

    return true;
  }

  function goToCurrentWeek() {
    const current =
      visibleWeeks.find((week) => week.weekStart === currentWeekId) ||
      visibleWeeks.find((week) => week.weekStart > currentWeekId) ||
      visibleWeeks[0];

    if (current) setSelectedWeek(current.weekStart);
  }

  function goToPreviousWeek() {
    const currentIndex = visibleWeeks.findIndex(
      (week) => week.weekStart === selectedWeek
    );

    if (currentIndex > 0) {
      setSelectedWeek(visibleWeeks[currentIndex - 1].weekStart);
    }
  }

  function goToNextWeek() {
    const currentIndex = visibleWeeks.findIndex(
      (week) => week.weekStart === selectedWeek
    );

    if (currentIndex >= 0 && currentIndex < visibleWeeks.length - 1) {
      setSelectedWeek(visibleWeeks[currentIndex + 1].weekStart);
    }
  }

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setAuthLoading(false);
    });

    return unsubscribe;
  }, []);

  async function loadBaseRota() {
    const snapshot = await getDocs(
      collection(db, "baseTemplate", "originalPattern", "shifts")
    );

    const rotaData = {};

    snapshot.forEach((doc) => {
      const data = doc.data();

      if (!rotaData[data.dayIndex]) {
        rotaData[data.dayIndex] = {};
      }

      rotaData[data.dayIndex][data.shift] = {
        staff: data.staff || [],
        id: doc.id,
      };
    });

    setRota(rotaData);
    return rotaData;
  }

  useEffect(() => {
    if (!user) {
      setWeeks([]);
      setSelectedWeek("");
      setRota({});
      setOverrides({});
      setLoadedOverridesForWeek("");
      setDataLoading(false);
      return;
    }

    let cancelled = false;

    async function loadInitialRotaData() {
      if (!cancelled) {
        setDataLoading(true);
        setOverrides({});
        setLoadedOverridesForWeek("");
      }

      try {
        // Always load the existing weeks first so the rota is usable.
        const loadedWeeks = await loadWeeks();

        // Admins then check if future weeks need creating.
        // If this fails, don't stop the rota from loading.
        if (isEditor) {
          try {
            const createdMissingWeeks = await ensureEightWeeks(loadedWeeks);

            if (createdMissingWeeks) {
              await loadWeeks();
            }
          } catch (err) {
            console.error("Failed to ensure eight weeks:", err);
          }
        }

        await loadBaseRota();
      } catch (error) {
        console.error("Failed to load initial rota data:", error);
      } finally {
        if (!cancelled) {
          setDataLoading(false);
        }
      }
    }

    loadInitialRotaData();

    return () => {
      cancelled = true;
    };
  }, [user, isEditor]);

  useEffect(() => {
    if (!user || weeks.length === 0) return;

    const availableWeeks = isEditor
      ? weeks
      : weeks.filter((week) => week.weekStart >= currentWeekId);

    const currentWeek =
      availableWeeks.find((week) => week.weekStart === currentWeekId) ||
      availableWeeks.find((week) => week.weekStart > currentWeekId) ||
      availableWeeks[0];

    if (
      currentWeek &&
      !availableWeeks.some((week) => week.weekStart === selectedWeek)
    ) {
      setSelectedWeek(currentWeek.weekStart);
    }
  }, [user, weeks, isEditor, selectedWeek, currentWeekId]);

  function clearLogoutTimers() {
    clearTimeout(warningTimer.current);
    clearTimeout(logoutTimer.current);
    clearInterval(countdownInterval.current);
  }

  function resetLogoutTimers() {
    clearLogoutTimers();

    warningActive.current = false;
    setShowLogoutWarning(false);
    setCountdown(30);

    warningTimer.current = setTimeout(() => {
      warningActive.current = true;
      setShowLogoutWarning(true);

      let remaining = 30;
      setCountdown(remaining);

      countdownInterval.current = setInterval(() => {
        remaining -= 1;
        setCountdown(remaining);

        if (remaining <= 0) {
          clearInterval(countdownInterval.current);
        }
      }, 1000);

      logoutTimer.current = setTimeout(async () => {
        clearLogoutTimers();
        warningActive.current = false;
        setShowLogoutWarning(false);
        await signOut(auth);
      }, 15 * 1000);
    }, 4.75 * 60 * 1000);
  }

  function handleUserActivity() {
    if (warningActive.current) return;
    resetLogoutTimers();
  }

  function continueSession() {
    resetLogoutTimers();
  }

  async function logoutNow() {
    clearLogoutTimers();
    warningActive.current = false;
    setShowLogoutWarning(false);
    await signOut(auth);
  }

  useEffect(() => {
    if (!user) {
      clearLogoutTimers();
      warningActive.current = false;
      setShowLogoutWarning(false);
      return;
    }

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];

    events.forEach((event) => {
      window.addEventListener(event, handleUserActivity);
    });

    resetLogoutTimers();

    return () => {
      clearLogoutTimers();

      events.forEach((event) => {
        window.removeEventListener(event, handleUserActivity);
      });
    };
  }, [user]);

  async function loadOverrides() {
    if (!selectedWeek) return;

    setOverridesLoading(true);
    setLoadedOverridesForWeek("");

    try {
      const snapshot = await getDocs(
        collection(db, "rotaWeeks", selectedWeek, "overrides")
      );

      const overrideData = {};

      snapshot.forEach((doc) => {
        const data = doc.data();

        if (data.active === false) return;

        if (!overrideData[data.dayIndex]) {
          overrideData[data.dayIndex] = {};
        }

        overrideData[data.dayIndex][data.shift] = data;
      });

      setOverrides(overrideData);
      setLoadedOverridesForWeek(selectedWeek);
    } catch (error) {
      console.error("Failed to load weekly overrides:", error);
      setOverrides({});
      setLoadedOverridesForWeek(selectedWeek);
    } finally {
      setOverridesLoading(false);
    }
  }

  useEffect(() => {
    if (!user || !selectedWeek) {
      setOverrides({});
      setLoadedOverridesForWeek("");
      setOverridesLoading(false);
      return;
    }

    loadOverrides();
  }, [user, selectedWeek]);

  async function login(event) {
    event.preventDefault();

    const email = usernameToEmail(username);

    try {
      await signInWithEmailAndPassword(auth, email, password);
      setPassword("");
    } catch (error) {
      alert("Login failed. Check username and password.");
      console.error(error);
    }
  }

  async function logout() {
    await signOut(auth);
  }

  function loadCellIntoEditor(dayIndex, shift) {
    if (!isEditor) return;

    const override = overrides?.[dayIndex]?.[shift];
    const baseStaff = rota?.[dayIndex]?.[shift]?.staff || [];

    setEditDayIndex(dayIndex);
    setEditShift(shift);
    setEditStaffText((override?.staff ?? baseStaff).join("\n"));
    setEditVacantSlots(override?.vacantSlots ?? 0);
    setEditNote(override?.note ?? "");
  }

  function loadSelectedCellIntoEditor() {
    loadCellIntoEditor(editDayIndex, editShift);
  }

  function loadBaseCellIntoEditor(dayIndex, shift) {
    if (!isEditor) return;

    const baseStaff = rota?.[dayIndex]?.[shift]?.staff || [];

    setBaseDayIndex(dayIndex);
    setBaseShift(shift);
    setBaseStaffText(baseStaff.join("\n"));
  }

  function loadSelectedBaseCellIntoEditor() {
    loadBaseCellIntoEditor(baseDayIndex, baseShift);
  }

  async function saveBaseShift() {
    if (!isEditor) return;

    const staff = baseStaffText
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);

    const existingId = rota?.[baseDayIndex]?.[baseShift]?.id;
    const baseShiftId = existingId || makeOverrideId(baseDayIndex, baseShift);

    await setDoc(
      doc(db, "baseTemplate", "originalPattern", "shifts", baseShiftId),
      {
        dayIndex: Number(baseDayIndex),
        shift: baseShift,
        staff,
        updatedAt: new Date().toISOString(),
        updatedBy: user?.email || "unknown",
      }
    );

    setRota((currentRota) => ({
      ...currentRota,
      [baseDayIndex]: {
        ...(currentRota?.[baseDayIndex] || {}),
        [baseShift]: {
          staff,
          id: baseShiftId,
        },
      },
    }));
  }

  async function clearBaseShift() {
    if (!isEditor) return;

    const existingId = rota?.[baseDayIndex]?.[baseShift]?.id;

    if (existingId) {
      await deleteDoc(
        doc(db, "baseTemplate", "originalPattern", "shifts", existingId)
      );
    }

    setBaseStaffText("");

    setRota((currentRota) => ({
      ...currentRota,
      [baseDayIndex]: {
        ...(currentRota?.[baseDayIndex] || {}),
        [baseShift]: {
          staff: [],
          id: existingId || makeOverrideId(baseDayIndex, baseShift),
        },
      },
    }));
  }

  async function saveOverride() {
    if (!selectedWeek || !isEditor) return;

    const staff = editStaffText
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);

    const overrideId = makeOverrideId(editDayIndex, editShift);

    await setDoc(doc(db, "rotaWeeks", selectedWeek, "overrides", overrideId), {
      dayIndex: Number(editDayIndex),
      shift: editShift,
      staff,
      vacantSlots: Number(editVacantSlots),
      note: editNote.trim(),
      overrideType: "GENERAL_OVERRIDE",
      editScope: "WEEK_ONLY",
      active: true,
      updatedAt: new Date().toISOString(),
      updatedBy: user?.email || "unknown",
    });

    await loadOverrides();
  }

  async function clearOverride() {
    if (!selectedWeek || !isEditor) return;

    const overrideId = makeOverrideId(editDayIndex, editShift);

    await deleteDoc(doc(db, "rotaWeeks", selectedWeek, "overrides", overrideId));

    setEditStaffText("");
    setEditVacantSlots(0);
    setEditNote("");

    await loadOverrides();
  }

  const dayLabels = selectedWeek
    ? Array.from({ length: 7 }, (_, index) => ({
        dayIndex: index + 1,
        label: formatDayLabel(addDays(selectedWeek, index)),
      }))
    : [];

  const weeklyRotaReady =
    !dataLoading &&
    Boolean(selectedWeek) &&
    !overridesLoading &&
    loadedOverridesForWeek === selectedWeek;

  if (authLoading) {
    return <main className="page">Loading...</main>;
  }

  if (!user) {
    return (
      <main className="page">
        <section className="login-panel">
          {/* <h1>LONGCROFT</h1> */}
            <img
              src={lcMonogram}
              alt="LC Monogram"
              className="lc-monogram login-monogram"
            />
          <h2>Staff Login</h2>
          <h1> </h1>
          <form onSubmit={login}>

            <label>
              Username
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="user or admin"
                autoComplete="username"
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>

            <button type="submit">Login</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <section className="rota-paper">
        <header className="rota-header">
          <div className="auth-bar">
            <span>
              Logged in as: <strong>{isEditor ? "admin" : "user"}</strong>
            </span>
          <div className="auth-actions">
            <button
              type="button"
              onClick={handlePrint}
              className="print-button"
            >
              Print Rota
            </button>

            <button type="button" onClick={logout}>
              Logout
            </button>
          </div>
        </div>
          <img
            src={lcMonogram}
            alt="LC Monogram"
            className="lc-monogram rota-monogram"
          />
          {/* <h1>LONGCROFT</h1> */}
          {/* <h2>Residential Care Home</h2> */}
          <h3>Staff Rota</h3>

          {adminView === "weekly" && (
            <>
              {selectedWeek && <p>W/C {formatWeekCommencing(selectedWeek)}</p>}

              <div className="week-nav">
                <button type="button" onClick={goToPreviousWeek}>
                  Previous Week
                </button>
                <button type="button" onClick={goToCurrentWeek}>
                  Current Week
                </button>
                <button type="button" onClick={goToNextWeek}>
                  Next Week
                </button>

              </div>

              <select
                value={selectedWeek}
                onChange={(e) => setSelectedWeek(e.target.value)}
                className="week-select"
              >
                {visibleWeeks.map((week) => (
                  <option key={week.id} value={week.weekStart}>
                    W/C {formatWeekCommencing(week.weekStart)}
                  </option>
                ))}
              </select>
          </>
          )}
          {isEditor && (
            <div className="admin-tabs">
              <button
                type="button"
                className={adminView === "weekly" ? "active-tab" : ""}
                onClick={() => setAdminView("weekly")}
              >
                Weekly Rota Editor
              </button>

              <button
                type="button"
                className={adminView === "base" ? "active-tab" : ""}
                onClick={() => setAdminView("base")}
              >
                Base Rota Editor
              </button>
            </div>
          )}
        </header>
        {adminView === "weekly" && (
          <>
            {!weeklyRotaReady ? (
              <p className="loading-text">Loading rota...</p>
            ) : (
              <>
        <table className="rota-table">
          <thead>
            <tr>
              <th>Shift</th>
              {dayLabels.map((day) => (
                <th key={day.dayIndex}>{day.label}</th>
              ))}
            </tr>
          </thead>

          <tbody>
            {SHIFTS.map((shift) => (
              <tr key={shift}>
                <th>{shift}</th>

                {dayLabels.map((day) => {
                  const override = overrides?.[day.dayIndex]?.[shift];

                  const staff =
                    override?.staff ??
                    rota?.[day.dayIndex]?.[shift]?.staff ??
                    [];

                  const note = override?.note || "";
                  const vacantSlots = override?.vacantSlots || 0;

                  const isSelected =
                    isEditor &&
                    Number(editDayIndex) === Number(day.dayIndex) &&
                    editShift === shift;

                  return (
                    <td
                      key={`${day.dayIndex}-${shift}`}
                      onClick={() => loadCellIntoEditor(day.dayIndex, shift)}
                      className={`${isEditor ? "clickable-cell" : ""} ${
                        isSelected ? "selected-cell" : ""
                      }`}
                      title={isEditor ? "Click to edit this shift" : ""}
                    >
                      {staff.length > 0 ? (
                        staff.map((person) => <div key={person}>{person}</div>)
                      ) : (
                        <span className="empty-cell">—</span>
                      )}

                      {vacantSlots > 0 && (
                        <div className="vacant">VACANT x{vacantSlots}</div>
                      )}

                      {note && <div className="note">{note}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mobile-rota-days">
          {dayLabels.map((day) => (
            <section key={day.dayIndex} className="mobile-day-card">
              <h4>{day.label}</h4>

              {SHIFTS.map((shift) => {
                const override = overrides?.[day.dayIndex]?.[shift];

                const staff =
                  override?.staff ?? rota?.[day.dayIndex]?.[shift]?.staff ?? [];

                const note = override?.note || "";
                const vacantSlots = override?.vacantSlots || 0;

                const isSelected =
                  isEditor &&
                  Number(editDayIndex) === Number(day.dayIndex) &&
                  editShift === shift;

                return (
                  <button
                    type="button"
                    key={`${day.dayIndex}-${shift}`}
                    onClick={() => loadCellIntoEditor(day.dayIndex, shift)}
                    className={`mobile-shift-card ${
                      isEditor ? "clickable-cell" : ""
                    } ${isSelected ? "selected-cell" : ""}`}
                    title={isEditor ? "Tap to edit this shift" : ""}
                  >
                    <span className="mobile-shift-title">{shift}</span>

                    <span className="mobile-shift-staff">
                      {staff.length > 0 ? (
                        staff.map((person) => <span key={person}>{person}</span>)
                      ) : (
                        <span className="empty-cell">—</span>
                      )}
                    </span>

                    {vacantSlots > 0 && (
                      <span className="vacant">VACANT x{vacantSlots}</span>
                    )}

                    {note && <span className="note">{note}</span>}
                  </button>
                );
              })}
            </section>
          ))}
        </div>

        {isEditor && (
          <section className="editor-panel">
            <h2>Override Editor</h2>

            <div className="editor-grid">
              <label>
                Day
                <select
                  value={editDayIndex}
                  onChange={(e) => setEditDayIndex(Number(e.target.value))}
                >
                  {DAYS.map((day) => (
                    <option key={day.dayIndex} value={day.dayIndex}>
                      {day.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Shift
                <select
                  value={editShift}
                  onChange={(e) => setEditShift(e.target.value)}
                >
                  {SHIFTS.map((shift) => (
                    <option key={shift} value={shift}>
                      {shift}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Vacant Slots
                <input
                  type="number"
                  min="0"
                  value={editVacantSlots}
                  onChange={(e) => setEditVacantSlots(e.target.value)}
                />
              </label>
            </div>

            <label className="editor-full">
              Staff Names
              <textarea
                value={editStaffText}
                onChange={(e) => setEditStaffText(e.target.value)}
                rows="5"
                placeholder={"S Crossley\nJ Jarvis"}
              />
            </label>

            <label className="editor-full">
              Note
              <input
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
                placeholder="Bank Required / Annual Leave / Sickness"
              />
            </label>

            <div className="editor-actions">
              <button type="button" onClick={loadSelectedCellIntoEditor}>
                Load Selected Cell
              </button>

              <button type="button" onClick={saveOverride}>
                Save Override
              </button>

              <button type="button" className="danger" onClick={clearOverride}>
                Clear Override
              </button>
            </div>
          </section>
        )}
              </>
            )}
          </>
        )}
        {isEditor && adminView === "base" && (
          <>
            <h2 className="base-editor-title">Base Rota Editor</h2>

            <table className="rota-table">
              <thead>
                <tr>
                  <th>Shift</th>
                  {DAYS.map((day) => (
                    <th key={day.dayIndex}>{day.name}</th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {SHIFTS.map((shift) => (
                  <tr key={shift}>
                    <th>{shift}</th>

                    {DAYS.map((day) => {
                      const base = rota?.[day.dayIndex]?.[shift];
                      const staff = base?.staff ?? [];

                      const isSelected =
                        Number(baseDayIndex) === Number(day.dayIndex) &&
                        baseShift === shift;

                      return (
                        <td
                          key={`${day.dayIndex}-${shift}`}
                          onClick={() => loadBaseCellIntoEditor(day.dayIndex, shift)}
                          className={`clickable-cell ${
                            isSelected ? "selected-cell" : ""
                          }`}
                          title="Click to edit this base shift"
                        >
                          {staff.length > 0 ? (
                            staff.map((person) => <div key={person}>{person}</div>)
                          ) : (
                            <span className="empty-cell">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mobile-rota-days">
              {DAYS.map((day) => (
                <section key={day.dayIndex} className="mobile-day-card">
                  <h4>{day.name}</h4>

                  {SHIFTS.map((shift) => {
                    const base = rota?.[day.dayIndex]?.[shift];
                    const staff = base?.staff ?? [];

                    const isSelected =
                      Number(baseDayIndex) === Number(day.dayIndex) &&
                      baseShift === shift;

                    return (
                      <button
                        type="button"
                        key={`${day.dayIndex}-${shift}`}
                        onClick={() => loadBaseCellIntoEditor(day.dayIndex, shift)}
                        className={`mobile-shift-card clickable-cell ${
                          isSelected ? "selected-cell" : ""
                        }`}
                        title="Tap to edit this base shift"
                      >
                        <span className="mobile-shift-title">{shift}</span>

                        <span className="mobile-shift-staff">
                          {staff.length > 0 ? (
                            staff.map((person) => <span key={person}>{person}</span>)
                          ) : (
                            <span className="empty-cell">—</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>

            <section className="editor-panel">
              <h2>Base Shift Editor</h2>

              <div className="editor-grid">
                <label>
                  Day
                  <select
                    value={baseDayIndex}
                    onChange={(e) => setBaseDayIndex(Number(e.target.value))}
                  >
                    {DAYS.map((day) => (
                      <option key={day.dayIndex} value={day.dayIndex}>
                        {day.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Shift
                  <select
                    value={baseShift}
                    onChange={(e) => setBaseShift(e.target.value)}
                  >
                    {SHIFTS.map((shift) => (
                      <option key={shift} value={shift}>
                        {shift}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="editor-full">
                Staff Names
                <textarea
                  value={baseStaffText}
                  onChange={(e) => setBaseStaffText(e.target.value)}
                  rows="5"
                  placeholder={"S Crossley\nJ Jarvis"}
                />
              </label>

              <div className="editor-actions">
                <button type="button" onClick={loadSelectedBaseCellIntoEditor}>
                  Load Selected Base Cell
                </button>

                <button type="button" onClick={saveBaseShift}>
                  Save Base Shift
                </button>

                <button type="button" className="danger" onClick={clearBaseShift}>
                  Clear Base Shift
                </button>
              </div>
            </section>
          </>
        )}
      </section>
      {showLogoutWarning && (
        <div className="modalOverlay">
          <div className="modal">
            <h2>Session Expiring</h2>

            <p>You have been inactive for nearly 5 minutes.</p>

            <p>
              You will be logged out in <strong>{countdown}</strong> seconds.
            </p>

            <div className="buttonRow">
                <button
                  type="button"
                  className="continueButton"
                  onClick={continueSession}
                >
                  Continue Session
                </button>

              <button type="button" className="dangerButton" onClick={logoutNow}>
                Logout Now
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;