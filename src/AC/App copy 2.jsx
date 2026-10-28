import { useEffect, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import autoTable from "jspdf-autotable";
import {
  collection,
  addDoc,
  getDocs,
  getDoc,
  query,
  orderBy,
  doc,
  setDoc,
  deleteDoc,
  writeBatch,
  limit,
  startAfter,
  serverTimestamp,
} from "firebase/firestore";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
} from "firebase/auth";
import { db, auth } from "./firebase";
import "./App.css";
import lcMonogram from "./assets/lc-monogram.png";

// Compact audit helpers. A tracked write and its log are committed atomically.
// These client-side helpers do not prevent bypass via direct Firestore writes.
function auditFields(value) {
  if (!value) return null;
  const { staff, vacantSlots, active, status, effectiveFrom, patternLength,
    contractedHours, contractHistory, staffType, role, paidHours,
    startDate, endDate, hours, date, shift, dayIndex, displayName,
    archived, publishedEarly, weekStart, employeeId, employees, leaveHours,
    leaveHoursByDate, absenceHoursByDate, actualHours, staffName } = value;
  return Object.fromEntries(Object.entries({
    staff, vacantSlots, active, status, effectiveFrom, patternLength,
    contractedHours, contractHistory, staffType, role, paidHours,
    startDate, endDate, hours, date, shift, dayIndex, displayName,
    archived, publishedEarly, weekStart, employeeId, employees, leaveHours,
    leaveHoursByDate, absenceHoursByDate, actualHours, staffName
  }).filter(([, item]) => item !== undefined));
}
function sameAuditValues(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function auditedWrite(reference, nextData, options = {}) {
  const beforeSnap = await getDoc(reference);
  const before = auditFields(beforeSnap.exists() ? beforeSnap.data() : null);
  const after = auditFields(options.delete ? null : options.merge && beforeSnap.exists()
    ? { ...beforeSnap.data(), ...nextData } : nextData);
  const batch = writeBatch(db);
  if (options.delete) batch.delete(reference);
  else batch.set(reference, nextData, options.merge ? { merge: true } : {});
  if (!sameAuditValues(before, after)) {
    batch.set(doc(collection(db, "auditLogs")), {
      actorUid: auth.currentUser?.uid || null,
      actorEmail: auth.currentUser?.email || null,
      action: options.delete ? "delete" : beforeSnap.exists() ? "update" : "create",
      targetPath: reference.path, category: reference.path.split("/")[0],
      before, after, createdAt: serverTimestamp(),
    });
  }
  await batch.commit();
}

const SHIFTS = ["Manager\n9am-5pm", "9am-5pm", "5pm-10pm", "10pm-9am"];

const PAYROLL_SHIFT_HOURS = {
  "Manager\n9am-5pm": 8,
  "9am-5pm": 8,
  "5pm-10pm": 5,
  "10pm-9am": 11,
};


const PREVIOUS_LIVE_WEEKS = 4;
const FUTURE_LIVE_WEEKS = 7;
const ARCHIVE_SCHEMA_VERSION = 1;

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
  const resultDate = new Date(date);
  resultDate.setDate(resultDate.getDate() + weeks * 7);
  return resultDate;
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

function formatAnnualLeaveDate(dateString) {
  return parseLocalDate(dateString).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function annualLeaveOverlapsWeek(leave, weekId) {
  if (!weekId || !leave?.startDate || !leave?.endDate) return false;

  const weekEnd = toDateId(addDays(weekId, 6));
  return leave.startDate <= weekEnd && leave.endDate >= weekId;
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


function getOldestLiveWeekId() {
  return toDateId(addWeeks(getCurrentMondayDate(), -PREVIOUS_LIVE_WEEKS));
}

function getNewestLiveWeekId() {
  return toDateId(addWeeks(getCurrentMondayDate(), FUTURE_LIVE_WEEKS));
}

function normaliseWeekId(week) {
  return week?.weekStart || week?.weekCommencing || week?.id || "";
}

function makeOverrideId(dayIndex, shift) {
  return `${dayIndex}_${shift.replaceAll(" ", "_").replaceAll("-", "_")}`;
}

function usernameToEmail(username) {
  const cleaned = username.trim().toLowerCase();

  // Preserve the two existing shared accounts exactly as they work today.
  if (cleaned === "user") return "viewer@longcroft.local";
  if (cleaned === "admin") return "editor@longcroft.local";

  // Preserve backwards compatibility for any existing Firebase email login.
  if (cleaned.includes("@")) return cleaned;

  // Individual staff accounts use a username in the UI while Firebase Auth
  // receives an internal synthetic email address.
  return `${cleaned}@longcroft.internal`;
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
          .annual-leave-sidebar,
          .annual-leave-sidebar-toggle,
          .annual-leave-warning,
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
            font-size: 16px !important;
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
            margin-top: 12px;
            font-size: 14px;
            font-style: italic;
            color: #555;
          }

          .day-note {
            display: block !important;
            margin-top: 8px !important;
            padding-top: 7px !important;
            border-top: 1px solid #b8ad9d !important;
            font-size: 16px !important;
            line-height: 1.25 !important;
            font-style: normal !important;
            font-weight: 700 !important;
            text-align: center !important;
            color: #222 !important;
            white-space: normal !important;
            overflow-wrap: anywhere !important;
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


// Shadow is a display annotation, not a separate employee identity.
function stripShadow(name) {
  return String(name || "").trim().replace(/\s*\(Shadow\)$/i, "").trim();
}
function isShadow(name) {
  return /\s\(Shadow\)$/i.test(String(name || "").trim());
}

// Shared employee-register selector. Rota documents continue to store canonical names,
// preserving compatibility with historical weeks, payroll and existing Firestore data.
function RotaStaffPicker({ value = [], onChange, employees = [], label = "Staff Names", maxSelected = Infinity, allowShadow = false, disabled = false }) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [shadowMenu, setShadowMenu] = useState(null);
  const inputRef = useRef(null);
  const holdTimerRef = useRef(null);
  const holdStartRef = useRef(null);
  const holdOpenedRef = useRef(false);

  useEffect(() => {
    if (shadowMenu === null) return;
    const dismissOutside = (event) => {
      if (!event.target.closest?.(".rota-shadow-menu")) setShadowMenu(null);
    };
    const dismissOnEscape = (event) => {
      if (event.key === "Escape") setShadowMenu(null);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [shadowMenu]);

  useEffect(() => () => clearTimeout(holdTimerRef.current), []);

  function cancelHold() {
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    holdStartRef.current = null;
  }

  function startHold(event, index) {
    if (!allowShadow || disabled || event.pointerType === "mouse" || event.target.closest("button")) return;
    cancelHold();
    holdOpenedRef.current = false;
    holdStartRef.current = { x: event.clientX, y: event.clientY };
    holdTimerRef.current = setTimeout(() => {
      holdOpenedRef.current = true;
      setShadowMenu(index);
      setOpen(false);
      if (navigator.vibrate) navigator.vibrate(15);
    }, 550);
  }

  function moveHold(event) {
    if (!holdStartRef.current) return;
    if (Math.hypot(event.clientX - holdStartRef.current.x, event.clientY - holdStartRef.current.y) > 12) cancelHold();
  }

  const selectedNames = Array.isArray(value)
    ? value.map((name) => String(name || "").trim()).filter(Boolean)
    : [];

  const normaliseName = (name) =>
    stripShadow(name).replace(/\s+/g, " ").toLowerCase();

  const registeredEmployees = employees.filter((employee) => employee?.displayName);
  const availableEmployees = registeredEmployees
    .filter((employee) => employee.active !== false && !employee.archived)
    .filter((employee) =>
      !selectedNames.some((selectedName) =>
        normaliseName(selectedName) === normaliseName(employee.displayName) ||
        (employee.aliases || []).some((alias) =>
          normaliseName(alias) === normaliseName(selectedName)
        )
      )
    )
    .filter((employee) =>
      !search.trim() ||
      [employee.displayName, ...(employee.aliases || [])].some((name) =>
        normaliseName(name).includes(normaliseName(search))
      )
    )
    .sort((firstEmployee, secondEmployee) =>
      firstEmployee.displayName.localeCompare(secondEmployee.displayName)
    );

  function choose(employee) {
    if (!employee) return;
    if (disabled || selectedNames.length >= maxSelected) return;
    onChange([...selectedNames, employee.displayName]);
    setSearch("");
    setHighlight(0);
    setOpen(false);
    inputRef.current?.focus();
  }
  function remove(index) {
    if (disabled) return;
    onChange(selectedNames.filter((_, selectedIndex) => selectedIndex !== index));
    inputRef.current?.focus();
  }
  function toggleShadow(index) {
    if (disabled) return;
    onChange(selectedNames.map((name, selectedIndex) =>
      selectedIndex !== index
        ? name
        : isShadow(name)
          ? stripShadow(name)
          : `${stripShadow(name)} (Shadow)`
    ));
    setShadowMenu(null);
  }
  return (
    <div className="rota-staff-picker editor-full" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setShadowMenu(null); }
    }}>
      <span className="rota-staff-picker-label">{label}</span>
      <div className="rota-staff-picker-field" onClick={() => inputRef.current?.focus()}>
        {selectedNames.map((name, index) => {
          const matchingEmployee = registeredEmployees.find((employee) =>
            normaliseName(employee.displayName) === normaliseName(name) ||
            (employee.aliases || []).some((alias) => normaliseName(alias) === normaliseName(name))
          );
          return <span className={`rota-staff-chip ${isShadow(name) ? "rota-staff-chip-shadow" : ""} ${!matchingEmployee || matchingEmployee.active === false || matchingEmployee.archived ? "rota-staff-chip-legacy" : ""}`} key={`${name}-${index}`}
            onPointerDown={(event) => startHold(event, index)}
            onPointerMove={moveHold}
            onPointerUp={cancelHold}
            onPointerCancel={cancelHold}
            onClick={(event) => { if (holdOpenedRef.current) { event.stopPropagation(); event.preventDefault(); holdOpenedRef.current = false; } }}
            onContextMenu={allowShadow && !disabled ? (event) => { event.preventDefault(); cancelHold(); setShadowMenu(index); setOpen(false); } : undefined}>
            <span title={!matchingEmployee ? "Existing rota name not found in register" : matchingEmployee.active === false || matchingEmployee.archived ? "Inactive/archived employee — retained for historical accuracy" : matchingEmployee.displayName}>{name}</span>
            {allowShadow && shadowMenu === index && <span className="rota-shadow-menu"><button type="button" onClick={(event) => { event.stopPropagation(); toggleShadow(index); }}>{isShadow(name) ? "Remove Shadow" : "Shadow?"}</button></span>}
            <button type="button" disabled={disabled} className="rota-staff-chip-remove" aria-label={`Remove ${name}`} onClick={(event) => { event.stopPropagation(); remove(index); }}>×</button>
          </span>;
        })}
        {selectedNames.length < maxSelected && <input ref={inputRef} type="text" disabled={disabled} className="rota-staff-search" value={search}
          placeholder={selectedNames.length ? "Add another employee…" : "Search employee register…"}
          role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls="rota-staff-options"
          onFocus={() => { setOpen(true); setHighlight(0); }}
          onChange={(event) => {
            setSearch(event.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setHighlight((currentIndex) => Math.min(currentIndex + 1, availableEmployees.length - 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight((currentIndex) => Math.max(0, currentIndex - 1));
            }
            if (event.key === "Enter" && open && availableEmployees.length) {
              event.preventDefault();
              choose(availableEmployees[Math.max(0, highlight)]);
            }
            if (event.key === "Escape") {
              setOpen(false);
              setSearch("");
            }
            if (event.key === "Backspace" && !search && selectedNames.length) {
              remove(selectedNames.length - 1);
            }
          }}
        />}
      </div>
      {open && !disabled && selectedNames.length < maxSelected && <div className="rota-staff-options" role="listbox" id="rota-staff-options">
        {availableEmployees.length ? availableEmployees.map((employee, index) => <button type="button" role="option"
          aria-selected={index === highlight} className={`rota-staff-option ${index === highlight ? "is-highlighted" : ""}`}
          key={employee.id || employee.displayName}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(employee)}>
          <span className="rota-staff-option-initials">{employee.displayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</span>
          <span>{employee.displayName}</span>
        </button>) : <div className="rota-staff-empty">{registeredEmployees.length ? "No matching available employees" : "No employees available in the register"}</div>}
      </div>}
      {selectedNames.some((name) =>
        !registeredEmployees.some((employee) =>
          normaliseName(employee.displayName) === normaliseName(name) ||
          (employee.aliases || []).some((alias) => normaliseName(alias) === normaliseName(name))
        )
      ) &&
        <small className="rota-staff-hint">An existing name is not in the employee register. It will be retained until removed.</small>}
    </div>
  );
}

function App() {
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditEntries, setAuditEntries] = useState([]);
  const [auditCursor, setAuditCursor] = useState(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditError, setAuditError] = useState("");
  async function loadAuditEntries(reset = false) {
    if (auditBusy) return;
    setAuditBusy(true); setAuditError("");
    try {
      const parts = [orderBy("createdAt", "desc"), limit(40)];
      if (!reset && auditCursor) parts.push(startAfter(auditCursor));
      const snap = await getDocs(query(collection(db, "auditLogs"), ...parts));
      setAuditEntries((prev) => reset ? snap.docs.map(d => ({ id:d.id,...d.data() })) :
        [...prev, ...snap.docs.map(d => ({ id:d.id,...d.data() }))]);
      setAuditCursor(snap.docs.length === 40 ? snap.docs[snap.docs.length-1] : null);
    } catch (err) { setAuditError(err.message || "Could not load audit log."); }
    finally { setAuditBusy(false); }
  }
  function exportAuditJson() {
    const data = auditEntries.map(({ createdAt, ...rest }) => ({
      ...rest, createdAt: createdAt?.toDate?.()?.toISOString?.() || null
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `rota-audit-${new Date().toISOString().slice(0,10)}.json`;
    link.click(); URL.revokeObjectURL(url);
  }
  const [weeks, setWeeks] = useState([]);
  const [selectedWeek, setSelectedWeek] = useState("");
  const [scheduledWeek, setScheduledWeek] = useState("");
  const [scheduledCalendarOpen, setScheduledCalendarOpen] = useState(false);
  const [scheduledDraft, setScheduledDraft] = useState(null);
  const [deletingScheduledWeek, setDeletingScheduledWeek] = useState(false);
  const [scheduledLoading, setScheduledLoading] = useState(false);
  const [scheduledPublishing, setScheduledPublishing] = useState(false);
  const [scheduledDay, setScheduledDay] = useState(1);
  const [scheduledDayNoteIndex, setScheduledDayNoteIndex] = useState(null);
  const [scheduledDayNoteText, setScheduledDayNoteText] = useState("");
  const [scheduledShift, setScheduledShift] = useState(SHIFTS[0]);
  const [rota, setRota] = useState({});
  const [baseVersions, setBaseVersions] = useState([]);
  const [baseEditorRota, setBaseEditorRota] = useState({});
  const [baseEditorWeek2Rota, setBaseEditorWeek2Rota] = useState({});
  const [basePatternLength, setBasePatternLength] = useState(1);
  const [baseTemplateWeek, setBaseTemplateWeek] = useState(1);
  const [baseEffectiveFrom, setBaseEffectiveFrom] = useState("");
  const [allowGeneratedBaseWeeks, setAllowGeneratedBaseWeeks] = useState(false);
  const [editingBaseVersionId, setEditingBaseVersionId] = useState("");
  const [baseEditorLoading, setBaseEditorLoading] = useState(false);
  const [loadedBaseForWeek, setLoadedBaseForWeek] = useState("");
  const [overrides, setOverrides] = useState({});
  const [annualLeave, setAnnualLeave] = useState([]);
  const [annualLeaveArchive, setAnnualLeaveArchive] = useState([]);
  const [annualLeaveLoading, setAnnualLeaveLoading] = useState(false);
  const [annualLeaveSidebarOpen, setAnnualLeaveSidebarOpen] = useState(false);
  const [annualLeaveName, setAnnualLeaveName] = useState("");
  const [annualLeaveStartDate, setAnnualLeaveStartDate] = useState("");
  const [annualLeaveEndDate, setAnnualLeaveEndDate] = useState("");
  const [annualLeaveNote, setAnnualLeaveNote] = useState("");
  const [annualLeaveHoursByDate, setAnnualLeaveHoursByDate] = useState({});
  const [annualLeaveHoursLoading, setAnnualLeaveHoursLoading] = useState(false);
  const [annualLeaveSuggestionDetails, setAnnualLeaveSuggestionDetails] = useState({});
  const [editingAnnualLeaveId, setEditingAnnualLeaveId] = useState("");
  const [showPastAnnualLeave, setShowPastAnnualLeave] = useState(false);
  const [allowRetrospectiveAnnualLeave, setAllowRetrospectiveAnnualLeave] = useState(false);
  const [archiveWeeks, setArchiveWeeks] = useState([]);
  const [selectedArchiveWeek, setSelectedArchiveWeek] = useState("");
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [adminView, setAdminView] = useState("weekly");
  const [employees, setEmployees] = useState([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);
  const [employeeName, setEmployeeName] = useState("");
  const [employeeAliases, setEmployeeAliases] = useState("");
  const [employeeStaffType, setEmployeeStaffType] = useState("");
  const [employeeContractedHours, setEmployeeContractedHours] = useState("");
  const [employeeContractEffectiveFrom, setEmployeeContractEffectiveFrom] = useState(toDateId(new Date()));
  const [employeeActive, setEmployeeActive] = useState(true);
  const [editingEmployeeId, setEditingEmployeeId] = useState("");
  const [employeeEditorOpen, setEmployeeEditorOpen] = useState(false);
  const [staffArchiveOpen, setStaffArchiveOpen] = useState(false);
  const [accountEmployee, setAccountEmployee] = useState(null);
  const [accountUsername, setAccountUsername] = useState("");
  const [accountRoleDraft, setAccountRoleDraft] = useState("staff");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [accountActionLoading, setAccountActionLoading] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordChangeLoading, setPasswordChangeLoading] = useState(false);
  const [viewerEmployeeId, setViewerEmployeeId] = useState("");
  const [staffDirectory, setStaffDirectory] = useState([]);
  const [viewerUpcomingShifts, setViewerUpcomingShifts] = useState([]);
  const [viewerPreviousShifts, setViewerPreviousShifts] = useState([]);
  const [showPreviousShifts, setShowPreviousShifts] = useState(false);
  const [viewerUpcomingShiftsLoading, setViewerUpcomingShiftsLoading] = useState(false);
  const [upcomingShiftsSidebarOpen, setUpcomingShiftsSidebarOpen] = useState(false);
  const [userProfile, setUserProfile] = useState(null);
  const [userProfileLoading, setUserProfileLoading] = useState(false);
  const [payrollWeek, setPayrollWeek] = useState("");
  const [payrollPreview, setPayrollPreview] = useState([]);
  const [payrollShadows, setPayrollShadows] = useState([]);
  const [payrollUnmatchedNames, setPayrollUnmatchedNames] = useState([]);
  const [payrollPreviewLoading, setPayrollPreviewLoading] = useState(false);
  const [sicknessAbsences, setSicknessAbsences] = useState([]);
  const [sicknessEmployeeId, setSicknessEmployeeId] = useState("");
  const [sicknessStartDate, setSicknessStartDate] = useState("");
  const [sicknessEndDate, setSicknessEndDate] = useState("");
  const [sicknessNote, setSicknessNote] = useState("");
  const [sicknessHoursByDate, setSicknessHoursByDate] = useState({});
  const [sicknessSuggestionDetails, setSicknessSuggestionDetails] = useState({});
  const [sicknessLoading, setSicknessLoading] = useState(false);
  const [editingSicknessId, setEditingSicknessId] = useState("");
  const [payrollAdjustments, setPayrollAdjustments] = useState([]);
  const [adjustmentDate, setAdjustmentDate] = useState("");
  const [adjustmentHours, setAdjustmentHours] = useState("");
  const [adjustmentNote, setAdjustmentNote] = useState("");
  const [adjustmentEmployeeIds, setAdjustmentEmployeeIds] = useState([]);
  const [editingAdjustmentId, setEditingAdjustmentId] = useState("");
  const [actualHoursOverrides, setActualHoursOverrides] = useState([]);
  const [actualOverrideDate, setActualOverrideDate] = useState("");
  const [actualOverrideHours, setActualOverrideHours] = useState("");
  const [actualOverrideNote, setActualOverrideNote] = useState("");
  const [actualOverrideEmployeeId, setActualOverrideEmployeeId] = useState("");
  const [editingActualOverrideId, setEditingActualOverrideId] = useState("");
  const [payrollMode, setPayrollMode] = useState("weekly");
  const [payrollStartDate, setPayrollStartDate] = useState("");
  const [payrollEndDate, setPayrollEndDate] = useState("");
  const [payrollPeriodLabel, setPayrollPeriodLabel] = useState("");
  const [editDayIndex, setEditDayIndex] = useState(1);
  const [editShift, setEditShift] = useState("9am-5pm");
  const [editStaffText, setEditStaffText] = useState("");
  const [editVacantSlots, setEditVacantSlots] = useState(0);
  const [editNote, setEditNote] = useState("");
  const [editDayNoteIndex, setEditDayNoteIndex] = useState(null);
  const [editDayNote, setEditDayNote] = useState("");
  const [baseDayIndex, setBaseDayIndex] = useState(1);
  const [baseShift, setBaseShift] = useState("9am-5pm");
  const [baseStaffText, setBaseStaffText] = useState("");
  const [baseVacantSlots, setBaseVacantSlots] = useState(0);
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [loadErrors, setLoadErrors] = useState({});
  const [loadStatus, setLoadStatus] = useState({});
  const [initialLoadSlow, setInitialLoadSlow] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const initialLoadTimeoutRef = useRef(null);
  const secondaryRequestsRef = useRef({});
  const loadingGenerationRef = useRef(0);
  const [initialRotaReady, setInitialRotaReady] = useState(false);
  const [overridesLoading, setOverridesLoading] = useState(false);
  const [loadedOverridesForWeek, setLoadedOverridesForWeek] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const logoutTimer = useRef(null);
  const warningTimer = useRef(null);
  const countdownInterval = useRef(null);
  const warningActive = useRef(false);
  const maintenanceStartedRef = useRef(false);
  const archiveLoadPromiseRef = useRef(null);
  const [showLogoutWarning, setShowLogoutWarning] = useState(false);
  const [countdown, setCountdown] = useState(30);
  const isLegacyAdmin = user?.email === "editor@longcroft.local";
  const isLegacyViewer = user?.email === "viewer@longcroft.local";
  const accountRole = isLegacyAdmin
    ? "admin"
    : isLegacyViewer
      ? "viewer"
      : userProfile?.role || "staff";
  const isAdmin = accountRole === "admin";
  const isSenior = accountRole === "senior" || accountRole === "editor";
  const isEditor = isAdmin || isSenior;
  const isIndividualStaff = Boolean(user && !isLegacyAdmin && !isLegacyViewer && !isEditor);
  const hasPersonalUpcomingShifts = Boolean(user && !isLegacyAdmin && !isLegacyViewer && !isAdmin);
  const linkedEmployeeId = userProfile?.employeeId || "";
  const currentWeekId = getCurrentMondayId();
  const DEV = import.meta.env.DEV;
  const INACTIVITY_TIMEOUT = DEV
    ? 60 * 1000
    : 5 * 60 * 1000;
  const WARNING_DURATION = DEV
    ? 15 * 1000
    : 15 * 1000;
  const lastActivityTime = useRef(Date.now());

  const oldestLiveWeekId = getOldestLiveWeekId();
  const newestLiveWeekId = getNewestLiveWeekId();

  const visibleWeeks = weeks.filter((week) => {
    const weekId = normaliseWeekId(week);

    if (!weekId || (weekId > newestLiveWeekId && week.status !== "published-early")) return false;

    return isEditor
      ? weekId >= oldestLiveWeekId
      : weekId >= currentWeekId;
  }).sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  // Each independent section reports its own status; a failed optional request
  // must never be mistaken for an empty, successfully loaded dataset.
  async function loadSection(key, loader, { retries = 2 } = {}) {
    if (secondaryRequestsRef.current[key]) return secondaryRequestsRef.current[key];
    const generation = loadingGenerationRef.current;
    const task = (async () => {
      setLoadStatus((old) => ({ ...old, [key]: "loading" }));
      if (["employees", "annualLeave", "annualLeaveArchive", "payrollAdjustments", "sickness", "archive"].includes(key)) setPayrollPreview([]);
      setLoadErrors((old) => ({ ...old, [key]: "" }));
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const result = await loader();
          if (generation === loadingGenerationRef.current) {
            setLoadStatus((old) => ({ ...old, [key]: "ready" }));
            setLoadErrors((old) => ({ ...old, [key]: "" }));
          }
          return result;
        } catch (error) {
          if (attempt === retries) {
            if (generation === loadingGenerationRef.current) {
              setLoadStatus((old) => ({ ...old, [key]: "error" }));
              setLoadErrors((old) => ({ ...old, [key]: error?.message || "Unable to retrieve information." }));
            }
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 600 * (2 ** attempt)));
        }
      }
    })();
    secondaryRequestsRef.current[key] = task;
    try { return await task; }
    finally { if (secondaryRequestsRef.current[key] === task) delete secondaryRequestsRef.current[key]; }
  }

  function retrySection(key) {
    const actions = {
      employees: () => loadEmployees(),
      annualLeave: () => loadAnnualLeave(),
      annualLeaveArchive: () => loadAnnualLeaveArchive(),
      payrollAdjustments: () => loadPayrollAdjustments(),
      sickness: () => loadSicknessAbsences(),
      archive: () => loadArchiveWeeks(),
      base: () => loadBaseVersions(),
      weeks: () => loadWeeks(),
    };
    if (key === "weeks") { setLoadAttempt((value) => value + 1); return; }
    const action = actions[key];
    if (action) loadSection(key, action, { retries: 1 }).catch((error) => console.error(`Retry failed: ${key}`, error));
  }

  function SectionNotice({ section, title, children }) {
    const status = loadStatus[section];
    if (status === "ready") return null;
    return <div className={`section-load-notice ${status === "error" ? "section-load-error" : ""}`} role={status === "error" ? "alert" : "status"}>
      <strong>{status === "error" ? `${title} could not be loaded` : `Loading ${title.toLowerCase()}…`}</strong>
      {status === "error" ? <p>Information is temporarily unavailable. Existing records have not been replaced or deleted.</p> : null}
      {children}
      {status === "error" && <button type="button" onClick={() => retrySection(section)}>Retry {title}</button>}
    </div>;
  }

  async function loadWeeks() {
    const snapshot = await getDocs(collection(db, "rotaWeeks"));

    const loadedWeeks = snapshot.docs
      .map((weekDoc) => {
        const data = weekDoc.data();
        const weekStart =
          data.weekStart || data.weekCommencing || weekDoc.id;

        return {
          id: weekDoc.id,
          ...data,
          weekStart,
        };
      })
      .filter((week) => week.weekStart)
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

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
      missingWeeks.map(async (weekId) => {
        const staged = await getDoc(doc(db, "scheduledRotaWeeks", weekId));
        if (staged.exists() && staged.data().status === "draft") {
          await publishScheduledWeek(weekId, staged.data(), false);
          return;
        }
        await setDoc(doc(db, "rotaWeeks", weekId), {
          weekStart: weekId,
          title: "LONGCROFT Staff Rota",
          status: "published",
          templateVersion: "originalPattern",
          createdBy: "admin-login-check",
          createdAt: new Date().toISOString(),
        });
      })
    );

    return true;
  }

  // Scheduled weeks are stored independently until the rolling window reaches them.
  // Each draft contains a complete, frozen 7 x 4 shift snapshot.
  async function openScheduledWeek(weekId) {
    if (!isEditor || !weekId) return;
    setScheduledLoading(true);
    try {
      const existing = await getDoc(doc(db, "scheduledRotaWeeks", weekId));
      if (existing.exists()) {
        setScheduledDraft(existing.data());
      } else {
        const live = await getDoc(doc(db, "rotaWeeks", weekId));
        if (live.exists()) {
          alert("This week is already live. Please edit it in the Weekly Rota Editor.");
          return;
        }
        const base = await getBaseRotaForWeek(weekId);
        const shifts = {};
        DAYS.forEach(({ dayIndex }) => {
          shifts[dayIndex] = {};
          SHIFTS.forEach((shift) => {
            shifts[dayIndex][shift] = {
              staff: [...(base?.[dayIndex]?.[shift]?.staff || [])],
              vacantSlots: Math.max(0, Number(base?.[dayIndex]?.[shift]?.vacantSlots) || 0),
              note: "",
            };
          });
        });
        setScheduledDraft({ weekStart: weekId, status: "draft", shifts, dayNotes: {} });
      }
      setScheduledWeek(weekId);
      setScheduledDayNoteIndex(null);
      setScheduledDayNoteText("");
    } catch (error) {
      console.error(error);
      alert("Unable to load this scheduled week.");
    } finally { setScheduledLoading(false); }
  }

  function loadScheduledDayNote(dayIndex) {
    if (!scheduledDraft || scheduledDraft.status === "published") return;
    setScheduledDayNoteIndex(Number(dayIndex));
    setScheduledDayNoteText(scheduledDraft.dayNotes?.[dayIndex] || scheduledDraft.dayNotes?.[String(dayIndex)] || "");
  }

  function saveScheduledDayNote() {
    if (!scheduledDayNoteIndex || scheduledDraft?.status === "published") return;
    setScheduledDraft((previous) => ({
      ...previous,
      dayNotes: { ...previous.dayNotes, [String(scheduledDayNoteIndex)]: scheduledDayNoteText.trim() },
    }));
  }

  function clearScheduledDayNote() {
    if (!scheduledDayNoteIndex || scheduledDraft?.status === "published") return;
    setScheduledDraft((previous) => {
      const dayNotes = { ...previous.dayNotes };
      delete dayNotes[String(scheduledDayNoteIndex)];
      return { ...previous, dayNotes };
    });
    setScheduledDayNoteText("");
  }

  function updateScheduledCell(dayIndex, shift, patch) {
    setScheduledDraft((previous) => ({
      ...previous,
      shifts: {
        ...previous.shifts,
        [dayIndex]: {
          ...previous.shifts?.[dayIndex],
          [shift]: { ...previous.shifts?.[dayIndex]?.[shift], ...patch },
        },
      },
    }));
  }

  async function publishScheduledWeek(weekId, draft, early) {
    // Atomic publication: no half-created week is visible to readers.
    const batch = writeBatch(db);
    const now = new Date().toISOString();
    batch.set(doc(db, "rotaWeeks", weekId), {
      weekStart: weekId, title: "LONGCROFT Staff Rota",
      status: early ? "published-early" : "published",
      templateVersion: "scheduled-snapshot", dayNotes: draft.dayNotes || {},
      createdAt: now, createdBy: user?.uid || "scheduled-generator",
    }, { merge: true });
    DAYS.forEach(({ dayIndex }) => SHIFTS.forEach((shift) => {
      const cell = draft.shifts?.[dayIndex]?.[shift] || {};
      batch.set(doc(db, "rotaWeeks", weekId, "overrides", makeOverrideId(dayIndex, shift)), {
        dayIndex, shift, staff: canonicaliseRegisteredStaffNames((cell.staff || []).map((name) => String(name).trim()).filter(Boolean)),
        vacantSlots: Number(cell.vacantSlots || 0), note: cell.note || "",
        overrideType: "SCHEDULED_SNAPSHOT", editScope: "WEEK_ONLY",
        active: true, updatedAt: now, updatedBy: user?.uid || "scheduled-generator",
      });
    }));
    batch.set(doc(db, "scheduledRotaWeeks", weekId), {
      ...draft, weekStart: weekId, status: "published", publishedEarly: early,
      publishedAt: now, publishedBy: user?.uid || "scheduled-generator",
    });
    await batch.commit();
  }

  async function deleteEarlyPublishedWeek() {
    if (!isAdmin || deletingScheduledWeek || !selectedWeek || selectedWeek <= newestLiveWeekId) return;
    const week = weeks.find((item) => item.weekStart === selectedWeek);
    if (!week || week.status !== "published-early") return;
    if (!window.confirm(`Delete early-published W/C ${formatWeekCommencing(selectedWeek)}?\n\nThis removes its live rota and all saved shift overrides. The week will be generated normally when it enters the rolling eight-week window. This cannot be undone.`)) return;
    setDeletingScheduledWeek(true);
    try {
      // Recheck persisted state immediately before deletion, not just UI state.
      const weekRef = doc(db, "rotaWeeks", selectedWeek);
      const scheduledRef = doc(db, "scheduledRotaWeeks", selectedWeek);
      const [liveSnapshot, scheduledSnapshot] = await Promise.all([getDoc(weekRef), getDoc(scheduledRef)]);
      if (selectedWeek <= getNewestLiveWeekId() ||
          !liveSnapshot.exists() || liveSnapshot.data().status !== "published-early" ||
          !scheduledSnapshot.exists() || scheduledSnapshot.data().publishedEarly !== true) {
        alert("This week is no longer eligible for early-publication deletion.");
        return;
      }
      const overrides = await getDocs(collection(db, "rotaWeeks", selectedWeek, "overrides"));
      // Firestore batches support up to 500 writes; this snapshot has 28 overrides.
      if (overrides.size > 497) throw new Error("Too many overrides for safe atomic deletion.");
      const batch = writeBatch(db);
      overrides.forEach((item) => batch.delete(item.ref));
      batch.delete(weekRef);
      batch.delete(scheduledRef);
      await batch.commit();
      setScheduledDraft((old) => old?.weekStart === selectedWeek ? null : old);
      const refreshed = await loadWeeks();
      const available = refreshed.filter((item) => item.weekStart >= oldestLiveWeekId && item.weekStart <= newestLiveWeekId);
      setSelectedWeek(available.find((item) => item.weekStart === currentWeekId)?.weekStart || available[0]?.weekStart || "");
      alert("Early-published week deleted. It will be generated normally when its week enters the rolling window.");
    } catch (error) {
      console.error("Could not delete early-published week", error);
      alert("Could not delete the scheduled week. Check your Firestore permissions.");
    } finally {
      setDeletingScheduledWeek(false);
    }
  }

  async function saveScheduledDraft(publishEarly = false) {
    if (loadStatus.employees !== "ready") { alert("Employee register has not loaded. Retry loading it before publishing or saving scheduled shifts."); return; }
    if (!isEditor || !scheduledWeek || !scheduledDraft || scheduledPublishing || scheduledDraft.status === "published") return;
    setScheduledPublishing(true);
    try {
      const existingLive = await getDoc(doc(db, "rotaWeeks", scheduledWeek));
      if (existingLive.exists()) {
        alert("This week is already live. Use the Weekly Rota Editor to amend it.");
        return;
      }
      if (publishEarly) {
        await publishScheduledWeek(scheduledWeek, scheduledDraft, true);
        setScheduledDraft((previous) => ({ ...previous, status: "published", publishedEarly: true }));
        await loadWeeks();
        setSelectedWeek(scheduledWeek);
        setAdminView("weekly");
      } else {
        await setDoc(doc(db, "scheduledRotaWeeks", scheduledWeek), {
          ...scheduledDraft, weekStart: scheduledWeek, status: "draft", publishedEarly: false, publishEarly: false,
          updatedAt: new Date().toISOString(), updatedBy: user?.uid || "unknown",
        });
        setScheduledDraft((old) => ({ ...old, publishEarly: false, publishedEarly: false }));
        alert("Scheduled week saved privately. It will publish when the rolling rota reaches it.");
      }
    } catch (error) {
      console.error(error);
      alert("Scheduled week could not be saved. Check Firestore permissions.");
    } finally { setScheduledPublishing(false); }
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
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      setUserProfile(null);
      setInitialRotaReady(false);

      if (!firebaseUser) {
        setUserProfileLoading(false);
        setAuthLoading(false);
        return;
      }

      // The original admin/user accounts remain valid even without profile docs.
      if (
        firebaseUser.email === "editor@longcroft.local" ||
        firebaseUser.email === "viewer@longcroft.local"
      ) {
        setUserProfileLoading(false);
        setAuthLoading(false);
        return;
      }

      setUserProfileLoading(true);
      try {
        const profileSnapshot = await getDoc(doc(db, "users", firebaseUser.uid));
        setUserProfile(
          profileSnapshot.exists()
            ? { id: profileSnapshot.id, ...profileSnapshot.data() }
            : { role: "staff", employeeId: "", accountEnabled: true }
        );
      } catch (error) {
        console.error("Failed to load user profile:", error);
        setUserProfile({ role: "staff", employeeId: "", accountEnabled: true });
      } finally {
        setUserProfileLoading(false);
        setAuthLoading(false);
      }
    });

    return unsubscribe;
  }, []);

  function snapshotToRota(snapshot) {
    const rotaData = {};

    snapshot.forEach((shiftDoc) => {
      const data = shiftDoc.data();

      if (!rotaData[data.dayIndex]) {
        rotaData[data.dayIndex] = {};
      }

      rotaData[data.dayIndex][data.shift] = {
        staff: data.staff || [],
        vacantSlots: Math.max(0, Number(data.vacantSlots) || 0),
        id: shiftDoc.id,
      };
    });

    return rotaData;
  }

  async function loadLegacyBaseRota() {
    const snapshot = await getDocs(
      collection(db, "baseTemplate", "originalPattern", "shifts")
    );

    return snapshotToRota(snapshot);
  }

  async function loadBaseVersions() {
    const snapshot = await getDocs(collection(db, "baseTemplateVersions"));
    const versions = snapshot.docs
      .map((versionDoc) => ({ id: versionDoc.id, ...versionDoc.data() }))
      .filter((version) => version.effectiveFrom)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

    setBaseVersions(versions);
    return versions;
  }

  async function loadVersionRota(versionId, templateWeek = 1) {
    // Backwards compatibility: existing versions keep Week 1 in /shifts.
    // Two-week versions store Week 2 in /week2Shifts.
    const subcollection = templateWeek === 2 ? "week2Shifts" : "shifts";
    const snapshot = await getDocs(
      collection(db, "baseTemplateVersions", versionId, subcollection)
    );

    return snapshotToRota(snapshot);
  }

  function getVersionPatternLength(version) {
    return Number(version?.patternLength) === 2 ? 2 : 1;
  }

  function getTemplateWeekForCalendarWeek(weekId, version) {
    if (getVersionPatternLength(version) !== 2) return 1;

    const start = parseLocalDate(version.effectiveFrom);
    const target = parseLocalDate(weekId);
    const weeksSinceStart = Math.round((target - start) / (7 * 24 * 60 * 60 * 1000));

    return Math.abs(weeksSinceStart % 2) === 0 ? 1 : 2;
  }

  function findApplicableBaseVersion(weekId, versions = baseVersions) {
    return [...versions]
      .filter((version) => version.effectiveFrom <= weekId)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] || null;
  }

  async function getBaseRotaForWeek(weekId, versions = baseVersions) {
    const applicableVersion = findApplicableBaseVersion(weekId, versions);

    if (applicableVersion) {
      const templateWeek = getTemplateWeekForCalendarWeek(weekId, applicableVersion);
      return loadVersionRota(applicableVersion.id, templateWeek);
    }

    return loadLegacyBaseRota();
  }


  async function loadArchiveWeeks() {
    if (!isEditor) {
      setArchiveWeeks([]);
      setSelectedArchiveWeek("");
      setArchiveLoading(false);
      return [];
    }

    // Prevent overlapping Firestore reads. This is especially important on
    // slower iOS connections, where initial maintenance and a tab press could
    // previously start two archive loads and leave the loading UI out of sync.
    if (archiveLoadPromiseRef.current) {
      return archiveLoadPromiseRef.current;
    }

    setArchiveLoading(true);

    const loadPromise = (async () => {
      try {
        const snapshot = await getDocs(collection(db, "rotaArchive"));
        const loadedArchiveWeeks = snapshot.docs
          .map((archiveDoc) => ({ id: archiveDoc.id, ...archiveDoc.data() }))
          .filter((week) => week.weekStart)
          .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

        setArchiveWeeks(loadedArchiveWeeks);

        setSelectedArchiveWeek((currentSelection) => {
          if (
            currentSelection &&
            loadedArchiveWeeks.some(
              (week) => week.weekStart === currentSelection
            )
          ) {
            return currentSelection;
          }

          return loadedArchiveWeeks[0]?.weekStart || "";
        });

        return loadedArchiveWeeks;
      } catch (error) {
        console.error("Failed to load rota archive:", error);
        throw error;
      } finally {
        archiveLoadPromiseRef.current = null;
        setArchiveLoading(false);
      }
    })();

    archiveLoadPromiseRef.current = loadPromise;
    return loadPromise;
  }

  async function loadEmployees() {
    setEmployeesLoading(true);

    try {
      if (!isAdmin) {
        const directorySnapshot = await getDocs(collection(db, "staffDirectory"));
        const directory = directorySnapshot.docs
          .map((directoryDoc) => ({ id: directoryDoc.id, ...directoryDoc.data() }))
          .filter((employee) => employee.active !== false)
          .sort((a, b) =>
            (a.displayName || "").localeCompare(b.displayName || "")
          );

        setEmployees([]);
        setStaffDirectory(directory);
        return directory;
      }

      const [employeeSnapshot, directorySnapshot] = await Promise.all([
        getDocs(collection(db, "employees")),
        getDocs(collection(db, "staffDirectory")),
      ]);

      const loadedEmployees = employeeSnapshot.docs
        .map((employeeDoc) => ({ id: employeeDoc.id, ...employeeDoc.data() }))
        .sort((a, b) =>
          (a.displayName || "").localeCompare(b.displayName || "")
        );

      const directoryChanged = await syncStaffDirectoryIfNeeded(
        employeeSnapshot,
        directorySnapshot
      );

      const finalDirectorySnapshot = directoryChanged
        ? await getDocs(collection(db, "staffDirectory"))
        : directorySnapshot;

      const directory = finalDirectorySnapshot.docs
        .map((directoryDoc) => ({ id: directoryDoc.id, ...directoryDoc.data() }))
        .sort((a, b) =>
          (a.displayName || "").localeCompare(b.displayName || "")
        );

      setEmployees(loadedEmployees);
      setStaffDirectory(directory);
      return loadedEmployees;
    } catch (error) {
      console.error("Failed to load employee register/staff directory:", error);
      throw error;
    } finally {
      setEmployeesLoading(false);
    }
  }

  async function syncStaffDirectoryIfNeeded(employeeSnapshot, directorySnapshot) {
    if (!isAdmin) return false;

    const syncKey = "longcroft-staff-directory-last-check";
    const today = new Date().toISOString().slice(0, 10);

    try {
      if (window.localStorage.getItem(syncKey) === today) {
        return false;
      }
    } catch {
      // localStorage is only an optimisation; continue if unavailable.
    }

    try {
      const employeeDocs = employeeSnapshot?.docs
        ? employeeSnapshot.docs
        : (await getDocs(collection(db, "employees"))).docs;

      const directoryDocs = directorySnapshot?.docs
        ? directorySnapshot.docs
        : (await getDocs(collection(db, "staffDirectory"))).docs;

      const directoryById = new Map(
        directoryDocs.map((directoryDoc) => [
          directoryDoc.id,
          directoryDoc.data(),
        ])
      );

      const writes = [];

      for (const employeeDoc of employeeDocs) {
        const employee = employeeDoc.data();
        const directoryEmployee = directoryById.get(employeeDoc.id);

        const desiredDisplayName = employee.displayName || "";
        const desiredAliases = employee.aliases || [];
        const desiredActive = employee.active !== false;

        const existingAliases = directoryEmployee?.aliases || [];

        const needsUpdate =
          !directoryEmployee ||
          (directoryEmployee.displayName || "") !== desiredDisplayName ||
          directoryEmployee.active !== desiredActive ||
          JSON.stringify(existingAliases) !== JSON.stringify(desiredAliases);

        if (needsUpdate) {
          writes.push(
            setDoc(
              doc(db, "staffDirectory", employeeDoc.id),
              {
                displayName: desiredDisplayName,
                aliases: desiredAliases,
                active: desiredActive,
                updatedAt: new Date().toISOString(),
              },
              { merge: true }
            )
          );
        }

        directoryById.delete(employeeDoc.id);
      }

      // Remove stale directory entries whose employee record no longer exists.
      for (const staleEmployeeId of directoryById.keys()) {
        writes.push(deleteDoc(doc(db, "staffDirectory", staleEmployeeId)));
      }

      if (writes.length > 0) {
        await Promise.all(writes);
      }

      try {
        window.localStorage.setItem(syncKey, today);
      } catch {
        // Ignore storage failures; the comparison itself is safe to repeat.
      }

      return writes.length > 0;
    } catch (error) {
      console.error("Automatic staff directory sync failed:", error);
      return false;
    }
  }

  function getPayrollArchiveCutoffId() {
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - 35);
    return toDateId(cutoff);
  }

  async function archiveEmployee(employee) {
    if (!isAdmin || !employee?.id) return;
    if (!window.confirm(`Archive ${employee.displayName}? They will be removed from the current Staff register but retained for historical rota and payroll calculations.`)) return;

    const now = new Date().toISOString();
    try {
      await Promise.all([
        setDoc(doc(db, "employees", employee.id), {
          archived: true,
          archivedAt: now,
          archivedBy: user?.email || "unknown",
          active: false,
          updatedAt: now,
          updatedBy: user?.email || "unknown",
        }, { merge: true }),
        setDoc(doc(db, "staffDirectory", employee.id), {
          displayName: employee.displayName || "",
          aliases: employee.aliases || [],
          active: false,
          archived: true,
          updatedAt: now,
        }, { merge: true }),
      ]);
      if (editingEmployeeId === employee.id) clearEmployeeForm();
      await loadEmployees();
      setPayrollPreview([]);
    } catch (error) {
      console.error("Failed to archive employee:", error);
      alert("Employee could not be archived.");
    }
  }

  async function restoreArchivedEmployee(employee) {
    if (!isAdmin || !employee?.id) return;
    const now = new Date().toISOString();
    try {
      await Promise.all([
        setDoc(doc(db, "employees", employee.id), {
          archived: false,
          archivedAt: null,
          archivedBy: null,
          active: true,
          updatedAt: now,
          updatedBy: user?.email || "unknown",
        }, { merge: true }),
        setDoc(doc(db, "staffDirectory", employee.id), {
          displayName: employee.displayName || "",
          aliases: employee.aliases || [],
          active: true,
          archived: false,
          updatedAt: now,
        }, { merge: true }),
      ]);
      await loadEmployees();
      setPayrollPreview([]);
    } catch (error) {
      console.error("Failed to restore employee:", error);
      alert("Employee could not be restored.");
    }
  }

  // Staff type follows the login role unless a descriptive override is supplied.
  // This is display-only: it never grants or changes login permissions.
  function getEmployeeStaffType(employee) {
    const override = String(employee?.staffTypeOverride || "").trim();
    if (override) return override;
    const role = employee?.authUid ? (employee.accountRole || employee.role || "staff") : "staff";
    if (role === "senior" || role === "editor") return "Senior";
    if (role === "admin") return "Admin";
    // Preserve any previously entered custom type from older app versions.
    const legacy = String(employee?.staffType || "").trim();
    if (legacy && !["staff", "senior"].includes(legacy.toLowerCase())) return legacy;
    return "Staff";
  }

  function clearEmployeeForm() {
    setEditingEmployeeId("");
    setEmployeeName("");
    setEmployeeAliases("");
    setEmployeeStaffType("");
    setEmployeeContractedHours("");
    setEmployeeContractEffectiveFrom(toDateId(new Date()));
    setEmployeeActive(true);
  }

  function editEmployee(employee) {
    setEmployeeEditorOpen(true);
    setEditingEmployeeId(employee.id);
    setEmployeeName(employee.displayName || "");
    setEmployeeAliases((employee.aliases || []).join("\n"));
    setEmployeeStaffType(employee.staffTypeOverride || (!["staff", "senior"].includes(String(employee.staffType || "").toLowerCase()) ? employee.staffType || "" : ""));
    setEmployeeContractedHours(
      employee.contractedHours === undefined ||
      employee.contractedHours === null
        ? ""
        : String(employee.contractedHours)
    );
    setEmployeeContractEffectiveFrom(toDateId(new Date()));
    setEmployeeActive(employee.active !== false);
  }

  async function saveEmployee(event) {
    event.preventDefault();
    if (!isAdmin) return;

    const displayName = employeeName.trim();
    const contractedHours = Number(employeeContractedHours);

    if (!displayName) {
      alert("Enter the employee's rota name.");
      return;
    }

    if (
      employeeContractedHours === "" ||
      !Number.isFinite(contractedHours) ||
      contractedHours < 0
    ) {
      alert("Enter valid contracted weekly hours.");
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(employeeContractEffectiveFrom) ||
        toDateId(parseLocalDate(employeeContractEffectiveFrom)) !== employeeContractEffectiveFrom) {
      alert("Enter a valid contract effective date.");
      return;
    }

    const aliases = employeeAliases
      .split("\n")
      .map((alias) => alias.trim())
      .filter(Boolean)
      .filter(
        (alias, index, array) =>
          array.findIndex(
            (item) => item.toLowerCase() === alias.toLowerCase()
          ) === index
      );

    const duplicate = employees.find(
      (employee) =>
        employee.id !== editingEmployeeId &&
        (employee.displayName || "").trim().toLowerCase() ===
          displayName.toLowerCase()
    );

    if (duplicate) {
      alert("An employee with that rota name already exists.");
      return;
    }

    const employeeId =
      editingEmployeeId ||
      displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    if (!employeeId) {
      alert("Could not create a valid employee ID from that name.");
      return;
    }

    try {
      const existing = editingEmployeeId
        ? employees.find((employee) => employee.id === editingEmployeeId)
        : null;

      const now = new Date().toISOString();
      const history = Array.isArray(existing?.contractHistory) ? [...existing.contractHistory] : [];
      const previousHours = Number(existing?.contractedHours ?? contractedHours);
      // The pre-existing contract is the fallback for dates before the first
      // recorded effective date; no unverified historical dates are invented.
      const baselineContractedHours = Number(existing?.baselineContractedHours ?? previousHours);
      const contractChanged = !existing || previousHours !== contractedHours;
      if (contractChanged) {
        const entry = {
          effectiveFrom: employeeContractEffectiveFrom,
          hours: contractedHours,
          recordedAt: now,
          recordedBy: user?.uid || "unknown",
        };
        const index = history.findIndex((item) => item.effectiveFrom === employeeContractEffectiveFrom);
        if (index >= 0) {
          if (!window.confirm("A contract change already exists for this date. Replace its hours?")) return;
          history[index] = entry;
        } else history.push(entry);
      }
      history.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      const currentContract = [...history].reverse().find((item) => item.effectiveFrom <= getCurrentMondayId());

      await setDoc(
        doc(db, "employees", employeeId),
        {
          displayName,
          aliases,
          staffTypeOverride: employeeStaffType.trim(),
          contractedHours: currentContract ? Number(currentContract.hours) : baselineContractedHours,
          baselineContractedHours,
          contractHistory: history,
          active: employeeActive,
          createdAt: existing?.createdAt || now,
          createdBy: existing?.createdBy || user?.email || "unknown",
          updatedAt: now,
          updatedBy: user?.email || "unknown",
        },
        { merge: true }
      );

      // Viewer-safe identity mirror: contains rota names/aliases only, plus active status.
      // It deliberately excludes contracted hours, payroll data and account details.
      await setDoc(
        doc(db, "staffDirectory", employeeId),
        {
          displayName,
          aliases,
          active: employeeActive,
          updatedAt: now,
        },
        { merge: true }
      );

      clearEmployeeForm();
      setEmployeeEditorOpen(false);
      await loadEmployees();
    } catch (error) {
      console.error("Failed to save employee:", error);
      alert("Employee could not be saved.");
    }
  }

  async function deleteEmployee(employee) {
    if (!isAdmin || !employee?.id) return;

    if (
      !window.confirm(
        `Delete ${employee.displayName} from the employee register? This does not alter any rota or archived rota.`
      )
    ) {
      return;
    }

    try {
      await Promise.all([
        deleteDoc(doc(db, "employees", employee.id)),
        deleteDoc(doc(db, "staffDirectory", employee.id)),
      ]);

      if (editingEmployeeId === employee.id) {
        clearEmployeeForm();
      }

      await loadEmployees();
    } catch (error) {
      console.error("Failed to delete employee:", error);
      alert("Employee could not be deleted.");
    }
  }

  function normaliseAccountUsername(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9._-]/g, "");
  }

  function openAccountManager(employee) {
    if (!isAdmin) return;
    setAccountEmployee(employee);
    setAccountUsername(employee.username || "");
    setAccountRoleDraft(employee.accountRole || employee.role || "staff");
    setTemporaryPassword("");
  }

  function closeAccountManager() {
    setAccountEmployee(null);
    setAccountUsername("");
    setAccountRoleDraft("staff");
    setTemporaryPassword("");
  }

  async function callEmployeeAccountAction(action, payload) {
    if (!isAdmin || !user) throw new Error("Administrator access is required.");
    const idToken = await user.getIdToken(true);
    const response = await fetch("/.netlify/functions/employee-account", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Account operation failed.");
    return result;
  }

  async function handleCreateEmployeeAccount() {
    if (!accountEmployee?.id) return;
    const username = normaliseAccountUsername(accountUsername);
    if (username.length < 3) return alert("Enter a username of at least 3 characters.");
    if (temporaryPassword.length < 8) return alert("Temporary password must be at least 8 characters.");
    setAccountActionLoading(true);
    try {
      await callEmployeeAccountAction("create", { employeeId: accountEmployee.id, username, role: accountRoleDraft, temporaryPassword });
      alert(`Account created for ${accountEmployee.displayName}.`);
      closeAccountManager();
      await loadEmployees();
    } catch (error) { console.error(error); alert(error.message); }
    finally { setAccountActionLoading(false); }
  }

  async function handleResetEmployeePassword() {
    if (!accountEmployee?.id) return;
    if (temporaryPassword.length < 8) return alert("Temporary password must be at least 8 characters.");
    if (!window.confirm(`Reset ${accountEmployee.displayName}'s password to the temporary password entered here?`)) return;
    setAccountActionLoading(true);
    try {
      await callEmployeeAccountAction("resetPassword", { employeeId: accountEmployee.id, temporaryPassword });
      alert("Password reset. A new password will be required at next login.");
      setTemporaryPassword("");
      await loadEmployees();
    } catch (error) { console.error(error); alert(error.message); }
    finally { setAccountActionLoading(false); }
  }

  async function handleSaveEmployeeAccountAccess() {
    if (!accountEmployee?.id) return;
    setAccountActionLoading(true);
    try {
      await callEmployeeAccountAction("updateAccess", { employeeId: accountEmployee.id, role: accountRoleDraft, accountEnabled: accountEmployee.accountEnabled !== false });
      alert("Account access updated.");
      closeAccountManager();
      await loadEmployees();
    } catch (error) { console.error(error); alert(error.message); }
    finally { setAccountActionLoading(false); }
  }

  async function handleToggleEmployeeAccount(employee) {
    if (!employee?.authUid) return;
    const nextEnabled = employee.accountEnabled === false;
    if (!window.confirm(`${nextEnabled ? "Enable" : "Disable"} ${employee.displayName}'s login account?`)) return;
    setAccountActionLoading(true);
    try {
      await callEmployeeAccountAction("updateAccess", { employeeId: employee.id, role: employee.accountRole || "staff", accountEnabled: nextEnabled });
      setAccountEmployee((current) => current?.id === employee.id ? { ...current, accountEnabled: nextEnabled } : current);
      await loadEmployees();
    } catch (error) { console.error(error); alert(error.message); }
    finally { setAccountActionLoading(false); }
  }

  async function callOwnAccountAction(action, payload = {}) {
    if (!user) throw new Error("You must be signed in.");
    const idToken = await user.getIdToken(true);
    const response = await fetch("/.netlify/functions/employee-account", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Account operation failed.");
    return result;
  }

  async function handleForcedPasswordChange(event) {
    event.preventDefault();
    if (newPassword.length < 8) return alert("New password must be at least 8 characters.");
    if (newPassword !== confirmNewPassword) return alert("The two new passwords do not match.");
    setPasswordChangeLoading(true);
    try {
      await updatePassword(user, newPassword);
      await callOwnAccountAction("completePasswordChange", {
        employeeId: linkedEmployeeId,
      });
      setUserProfile((current) => ({
        ...(current || {}),
        mustChangePassword: false,
        passwordChangedAt: new Date().toISOString(),
      }));
      setNewPassword("");
      setConfirmNewPassword("");
    } catch (error) {
      console.error(error);
      alert("Password could not be changed. Sign out, sign in again with the temporary password, and retry.");
    } finally { setPasswordChangeLoading(false); }
  }

  function normalisePayrollName(name) {
    return stripShadow(name).replace(/\s+/g, " ").toLowerCase();
  }

  function isLoggedInEmployeeName(staffName) {
    if (!isIndividualStaff || !linkedEmployeeId) return false;

    const linkedEmployee = staffDirectory.find(
      (employee) => employee.id === linkedEmployeeId
    );
    if (!linkedEmployee) return false;

    return (
      normalisePayrollName(staffName) ===
      normalisePayrollName(linkedEmployee.displayName)
    );
  }

  function resolvePayrollEmployee(staffName, employeeList = null) {
    const resolvedEmployeeList = employeeList || (isAdmin ? employees : staffDirectory);
    const target = normalisePayrollName(staffName);
    if (!target) return null;

    return (
      resolvedEmployeeList.find((employee) => {
        const recognisedNames = [
          employee.displayName,
          ...(employee.aliases || []),
        ];

        return recognisedNames.some(
          (name) => normalisePayrollName(name) === target
        );
      }) || null
    );
  }

  function canonicaliseRegisteredStaffNames(staffNames, employeeList = null) {
    const resolvedEmployeeList = employeeList || (isAdmin ? employees : staffDirectory);

    return (staffNames || []).map((staffName) => {
      const enteredName = String(staffName || "").trim();
      if (!enteredName) return enteredName;

      const employee = resolvePayrollEmployee(enteredName, resolvedEmployeeList);

      // Exact register/alias matches are case-insensitive. When one is found,
      // always persist the canonical displayName from the staff register.
      // Unrecognised names are deliberately left untouched.
      return employee?.displayName ? `${employee.displayName}${isShadow(enteredName) ? " (Shadow)" : ""}` : enteredName;
    });
  }

  // Sickness is an accountant-facing absence record, not a paid-hours adjustment.
  // Confirmed daily hours are stored so subsequent rota edits cannot rewrite history.
  async function loadSicknessAbsences() {
    if (!isAdmin) { setSicknessAbsences([]); return []; }
    try {
      const snapshot = await getDocs(collection(db, "sicknessAbsences"));
      const records = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        .filter((item) => item.employeeId && item.startDate && item.endDate)
        .sort((a, b) => b.startDate.localeCompare(a.startDate));
      setSicknessAbsences(records);
      return records;
    } catch (error) {
      console.error("Could not load sickness absences:", error);
      throw error;
    }
  }

  function clearSicknessForm() {
    setEditingSicknessId(""); setSicknessEmployeeId("");
    setSicknessStartDate(""); setSicknessEndDate(""); setSicknessNote("");
    setSicknessHoursByDate({}); setSicknessSuggestionDetails({});
  }

  async function editSicknessAbsence(record) {
    setEditingSicknessId(record.id);
    setSicknessEmployeeId(record.employeeId);
    setSicknessStartDate(record.startDate);
    setSicknessEndDate(record.endDate);
    setSicknessNote(record.note || "");
    setSicknessHoursByDate(record.absenceHoursByDate || {});
    setSicknessSuggestionDetails({});
    // Populate the comparison immediately; retain confirmed hours as authority.
    await suggestSicknessHours(record);
  }

  async function suggestSicknessHours(editingRecord = null) {
    const employeeId = editingRecord?.employeeId || sicknessEmployeeId;
    const startDate = editingRecord?.startDate || sicknessStartDate;
    const endDate = editingRecord?.endDate || sicknessEndDate;
    const employee = employees.find((item) => item.id === employeeId);
    if (!employee || !startDate || !endDate || endDate < startDate) {
      alert("Select an employee and a valid sickness date range first."); return;
    }
    const days = getAnnualLeaveDateIds(startDate, endDate);
    if (days.length > 93) { alert("Record sickness in periods of 93 days or fewer."); return; }
    setSicknessLoading(true);
    try {
      const baseCache = new Map();
      const finalCache = new Map();
      const suggested = {}; const details = {};
      for (const dateId of days) {
        const date = parseLocalDate(dateId);
        const dayIndex = date.getDay() || 7;
        const weekId = toDateId(addDays(dateId, -(dayIndex - 1)));
        if (!baseCache.has(weekId)) baseCache.set(weekId, await getBaseRotaForWeek(weekId));
        const baseRota = baseCache.get(weekId);
        const baseHours = getEmployeeHoursFromBaseDay(baseRota, dayIndex, employee);
        const baseShiftCount = getEmployeeBaseShiftCount(baseRota, dayIndex, employee);
        const hasFinal = archiveWeeks.some((archivedWeek) =>
          archivedWeek.weekStart === weekId && archivedWeek.days
        ) || weeks.some((liveWeek) => normaliseWeekId(liveWeek) === weekId);
        let finalHours = null;
        if (hasFinal) {
          if (!finalCache.has(weekId)) finalCache.set(weekId, await getResolvedPayrollDays(weekId));
          finalHours = getEmployeeHoursFromResolvedDay(
            finalCache.get(weekId).find((d) => d.date === dateId), employee);
        }
        const override = actualHoursOverrides.find((item) => item.employeeId === employee.id && item.date === dateId);
        const worked = override ? Number(override.hours) : (finalHours ?? 0);
        // Base rota is a suggestion, not proof of a missed shift.
        const proposed = Math.max(0, baseHours - worked);
        const leaveOverlap = [...annualLeave, ...annualLeaveArchive].some((leave) =>
          resolvePayrollEmployee(leave.staffName)?.id === employee.id && annualLeaveCoversDate(leave, dateId));
        const existingOverlap = sicknessAbsences.some((item) => item.id !== (editingRecord?.id || editingSicknessId) &&
          item.employeeId === employee.id && item.startDate <= dateId && item.endDate >= dateId);
        suggested[dateId] = proposed;
        details[dateId] = { baseHours, finalHours, worked, leaveOverlap, existingOverlap,
          review: baseShiftCount > 1 || (finalHours !== null && finalHours > baseHours) ||
            Boolean(override) || leaveOverlap || existingOverlap || baseHours === 0 };
      }
      // Refreshing an existing record must never overwrite confirmed hours.
      // If the user changes the date range, new dates receive suggestions only.
      if (editingRecord) {
        setSicknessHoursByDate(Object.fromEntries(days.map((date) =>
          [date, editingRecord.absenceHoursByDate?.[date] ?? suggested[date]])));
      } else {
        setSicknessHoursByDate((current) => editingSicknessId
          ? Object.fromEntries(days.map((date) => [date, current[date] ?? suggested[date]]))
          : suggested);
      }
      setSicknessSuggestionDetails(details);
    } catch (error) {
      console.error("Sickness rota comparison failed:", error);
      alert("Could not compare rota sources for sickness. Check that relevant rota weeks are available.");
    } finally { setSicknessLoading(false); }
  }

  async function saveSicknessAbsence(event) {
    event.preventDefault();
    if (!isAdmin || sicknessLoading) return;
    const employee = employees.find((item) => item.id === sicknessEmployeeId);
    if (!employee || !sicknessStartDate || !sicknessEndDate || sicknessEndDate < sicknessStartDate) {
      alert("Select an employee and valid dates."); return;
    }
    const dates = getAnnualLeaveDateIds(sicknessStartDate, sicknessEndDate);
    if (dates.length > 93) { alert("Record sickness in periods of 93 days or fewer."); return; }
    if (dates.some((date) => sicknessHoursByDate[date] === undefined || sicknessHoursByDate[date] === "" ||
      !Number.isFinite(Number(sicknessHoursByDate[date])) || Number(sicknessHoursByDate[date]) < 0 ||
      Number(sicknessHoursByDate[date]) > 24)) {
      alert("Compare rota sources and confirm 0–24 sickness hours for every date."); return;
    }
    const conflicts = dates.filter((date) => [...annualLeave, ...annualLeaveArchive].some((leave) =>
      resolvePayrollEmployee(leave.staffName)?.id === employee.id && annualLeaveCoversDate(leave, date)));
    if (conflicts.length) {
      alert(`Annual leave overlaps sickness on ${conflicts.map(formatAnnualLeaveDate).join(", ")}. Resolve the annual leave record first.`);
      return;
    }
    const otherAbsence = sicknessAbsences.find((item) => item.id !== editingSicknessId &&
      item.employeeId === employee.id && item.startDate <= sicknessEndDate && item.endDate >= sicknessStartDate);
    if (otherAbsence) { alert("Another sickness episode overlaps these dates. Edit the existing episode or change the dates."); return; }
    const confirmed = Object.fromEntries(dates.map((date) => [date, Number(sicknessHoursByDate[date])]));
    const now = new Date().toISOString();
    setSicknessLoading(true);
    try {
      const reference = editingSicknessId ? doc(db, "sicknessAbsences", editingSicknessId) : doc(collection(db, "sicknessAbsences"));
      await auditedWrite(reference, {
        employeeId: employee.id, displayName: employee.displayName,
        startDate: sicknessStartDate, endDate: sicknessEndDate,
        absenceHoursByDate: confirmed, note: sicknessNote.trim(),
        updatedAt: now, updatedBy: user?.uid || "unknown",
        ...(!editingSicknessId ? { createdAt: now, createdBy: user?.uid || "unknown" } : {}),
      }, { merge: true });
      clearSicknessForm();
      await loadSicknessAbsences();
      setPayrollPreview([]);
    } catch (error) { console.error("Failed to save sickness:", error); alert("Sickness record could not be saved."); }
    finally { setSicknessLoading(false); }
  }

  async function deleteSicknessAbsence(record) {
    if (!isAdmin || !window.confirm(`Delete sickness record for ${record.displayName}?`)) return;
    try {
      await auditedWrite(doc(db, "sicknessAbsences", record.id), null, { delete: true });
      if (editingSicknessId === record.id) clearSicknessForm();
      await loadSicknessAbsences(); setPayrollPreview([]);
    } catch (error) { console.error(error); alert("Could not delete sickness record."); }
  }

  function sicknessHoursForPeriod(startDate, endDate) {
    const totals = new Map();
    sicknessAbsences.forEach((record) => {
      Object.entries(record.absenceHoursByDate || {}).forEach(([date, value]) => {
        if (date < startDate || date > endDate) return;
        totals.set(record.employeeId, (totals.get(record.employeeId) || 0) + Number(value || 0));
      });
    });
    return totals;
  }

  async function loadPayrollAdjustments() {
    if (!isAdmin) {
      setPayrollAdjustments([]);
      return [];
    }

    try {
      const snapshot = await getDocs(collection(db, "payrollAdjustments"));
      const loaded = snapshot.docs
        .map((adjustmentDoc) => ({ id: adjustmentDoc.id, ...adjustmentDoc.data() }))
        .filter((item) => item.date && Number.isFinite(Number(item.hours)))
        .sort((a, b) => b.date.localeCompare(a.date));
      const adjustments = loaded.filter((item) => item.type !== "actualHoursOverride");
      const actualOverrides = loaded.filter((item) => item.type === "actualHoursOverride");
      setPayrollAdjustments(adjustments);
      setActualHoursOverrides(actualOverrides);
      return adjustments;
    } catch (error) {
      console.error("Failed to load payroll adjustments:", error);
      throw error;
    }
  }

  function clearPayrollAdjustmentForm() {
    setEditingAdjustmentId("");
    setAdjustmentDate("");
    setAdjustmentHours("");
    setAdjustmentNote("");
    setAdjustmentEmployeeIds([]);
  }

  function toggleAdjustmentEmployee(employeeId) {
    setAdjustmentEmployeeIds((current) =>
      current.includes(employeeId)
        ? current.filter((id) => id !== employeeId)
        : [...current, employeeId]
    );
  }

  function editPayrollAdjustment(adjustment) {
    setEditingAdjustmentId(adjustment.id);
    setAdjustmentDate(adjustment.date || "");
    setAdjustmentHours(String(adjustment.hours ?? ""));
    setAdjustmentNote(adjustment.note || "");
    setAdjustmentEmployeeIds(
      (adjustment.employees || []).map((employee) => employee.employeeId).filter(Boolean)
    );
  }

  async function savePayrollAdjustment(event) {
    event.preventDefault();
    if (!isAdmin) return;

    const hours = Number(adjustmentHours);
    if (!adjustmentDate || !Number.isFinite(hours) || hours <= 0) {
      alert("Choose a date and enter a positive number of adjustment hours.");
      return;
    }
    if (adjustmentEmployeeIds.length === 0) {
      alert("Select at least one employee for this adjustment.");
      return;
    }

    const selectedEmployees = adjustmentEmployeeIds
      .map((employeeId) => employees.find((employee) => employee.id === employeeId))
      .filter(Boolean)
      .map((employee) => ({ employeeId: employee.id, displayName: employee.displayName }));

    const adjustmentId = editingAdjustmentId || undefined;
    const ref = adjustmentId
      ? doc(db, "payrollAdjustments", adjustmentId)
      : doc(collection(db, "payrollAdjustments"));

    await auditedWrite(ref, {
      date: adjustmentDate,
      hours,
      note: adjustmentNote.trim(),
      employees: selectedEmployees,
      updatedAt: new Date().toISOString(),
      updatedBy: user?.email || "unknown",
      ...(!adjustmentId ? { createdAt: new Date().toISOString(), createdBy: user?.email || "unknown" } : {}),
    }, { merge: true });

    clearPayrollAdjustmentForm();
    await loadPayrollAdjustments();
    setPayrollPreview([]);
  }

  async function deletePayrollAdjustment(adjustment) {
    if (!isAdmin || !adjustment?.id) return;
    if (!window.confirm("Delete this payroll adjustment?")) return;
    await auditedWrite(doc(db, "payrollAdjustments", adjustment.id), null, { delete: true });
    if (editingAdjustmentId === adjustment.id) clearPayrollAdjustmentForm();
    await loadPayrollAdjustments();
    setPayrollPreview([]);
  }

  function clearActualHoursOverrideForm() {
    setEditingActualOverrideId("");
    setActualOverrideDate("");
    setActualOverrideHours("");
    setActualOverrideNote("");
    setActualOverrideEmployeeId("");
  }

  function editActualHoursOverride(override) {
    setEditingActualOverrideId(override.id);
    setActualOverrideDate(override.date || "");
    setActualOverrideHours(String(override.hours ?? ""));
    setActualOverrideNote(override.note || "");
    setActualOverrideEmployeeId(override.employeeId || "");
  }

  async function saveActualHoursOverride(event) {
    event.preventDefault();
    if (!isAdmin) return;
    const hours = Number(actualOverrideHours);
    if (!actualOverrideDate || !actualOverrideEmployeeId || !Number.isFinite(hours) || hours < 0) {
      alert("Choose an employee and date, then enter actual hours of 0 or more.");
      return;
    }
    const employee = employees.find((item) => item.id === actualOverrideEmployeeId);
    if (!employee) return;

    // Sanity check: an actual-hours override may only replace hours for a day
    // on which this employee is actually present on the resolved rota.
    // This deliberately checks the final rota (base + overrides, or archive),
    // rather than merely trusting the employee/date selected in the form.
    try {
      const selectedDate = parseLocalDate(actualOverrideDate);
      const dayOffsetFromMonday = (selectedDate.getDay() + 6) % 7;
      const weekStartDate = new Date(selectedDate);
      weekStartDate.setDate(selectedDate.getDate() - dayOffsetFromMonday);
      const weekId = toDateId(weekStartDate);

      const resolvedDays = await getResolvedPayrollDays(weekId);
      const resolvedDay = resolvedDays.find((day) => day.date === actualOverrideDate);
      const rotaHoursForEmployee = getEmployeeHoursFromResolvedDay(resolvedDay, employee);

      if (rotaHoursForEmployee <= 0) {
        alert(
          `${employee.displayName} is not on a rota shift on ${formatAnnualLeaveDate(actualOverrideDate)}. ` +
          "An actual-hours override can only replace hours for a shift that already exists on the rota. " +
          "If the employee worked an unplanned extra shift, use a payroll adjustment or amend the rota instead."
        );
        return;
      }
    } catch (error) {
      console.error("Could not verify actual-hours override against rota:", error);
      alert(
        "The rota could not be verified for that employee and date, so the override was not saved. " +
        "Check that the relevant rota week is available, then try again."
      );
      return;
    }

    const existingForDay = actualHoursOverrides.find((item) =>
      item.id !== editingActualOverrideId &&
      item.date === actualOverrideDate &&
      item.employeeId === actualOverrideEmployeeId
    );
    if (existingForDay) {
      alert("An actual-hours override already exists for this employee on this date. Edit the existing override instead.");
      return;
    }
    const ref = editingActualOverrideId
      ? doc(db, "payrollAdjustments", editingActualOverrideId)
      : doc(collection(db, "payrollAdjustments"));
    await auditedWrite(ref, {
      type: "actualHoursOverride",
      date: actualOverrideDate,
      hours,
      employeeId: employee.id,
      displayName: employee.displayName,
      note: actualOverrideNote.trim(),
      updatedAt: new Date().toISOString(),
      updatedBy: user?.email || "unknown",
      ...(!editingActualOverrideId ? { createdAt: new Date().toISOString(), createdBy: user?.email || "unknown" } : {}),
    }, { merge: true });
    clearActualHoursOverrideForm();
    await loadPayrollAdjustments();
    setPayrollPreview([]);
  }

  async function deleteActualHoursOverride(override) {
    if (!isAdmin || !override?.id) return;
    if (!window.confirm("Delete this actual-hours override? Payroll will return to the rota-derived hours for that date.")) return;
    await auditedWrite(doc(db, "payrollAdjustments", override.id), null, { delete: true });
    if (editingActualOverrideId === override.id) clearActualHoursOverrideForm();
    await loadPayrollAdjustments();
    setPayrollPreview([]);
  }

  function getActualHoursOverridesForPeriod(startDate, endDate) {
    const result = new Map();
    actualHoursOverrides
      .filter((item) => item.date >= startDate && item.date <= endDate)
      .forEach((item) => result.set(`${item.employeeId}|${item.date}`, Number(item.hours || 0)));
    return result;
  }

  function getAdjustmentHoursForPeriod(startDate, endDate, employeeList = employees) {
    const totals = new Map(employeeList.map((employee) => [employee.id, 0]));
    payrollAdjustments
      .filter((adjustment) => adjustment.date >= startDate && adjustment.date <= endDate)
      .forEach((adjustment) => {
        (adjustment.employees || []).forEach((selected) => {
          if (!totals.has(selected.employeeId)) return;
          totals.set(selected.employeeId, (totals.get(selected.employeeId) || 0) + Number(adjustment.hours || 0));
        });
      });
    return totals;
  }

  function buildPayrollPreviewFromDays(
    days,
    employeeList = employees,
    contractedHoursByEmployee = new Map(),
    annualLeaveHoursByEmployee = new Map(),
    adjustmentHoursByEmployee = new Map(),
    actualHoursOverrideMap = new Map(),
    sicknessHoursByEmployee = new Map()
  ) {
    const totals = new Map();
    const unmatched = new Set();

    employeeList.forEach((employee) => {
      const weeklyContractedHours = Number(employee.contractedHours || 0);
      totals.set(employee.id, {
        employeeId: employee.id,
        displayName: employee.displayName,
        weeklyContractedHours,
        contractedHours: Number(
          contractedHoursByEmployee.get(employee.id) ?? weeklyContractedHours
        ),
        sicknessHours: Number(sicknessHoursByEmployee.get(employee.id) || 0),
        annualLeaveHours: Number(
          annualLeaveHoursByEmployee.get(employee.id) ?? 0
        ),
        active: employee.active !== false,
        adjustmentHours: Number(adjustmentHoursByEmployee.get(employee.id) ?? 0),
        workedHours: 0,
        rotaWorkedHours: 0,
        shiftsWorked: 0,
        shiftBreakdown: [],
        dailyWorkedHours: {},
        actualHoursOverrideDates: [],
      });
    });

    days.forEach((day) => {
      (day.shifts || []).forEach((shiftData) => {
        const shiftHours = PAYROLL_SHIFT_HOURS[shiftData.shift];
        if (!Number.isFinite(shiftHours)) return;

        (shiftData.staff || []).forEach((staffName) => {
          const employee = resolvePayrollEmployee(staffName, employeeList);

          if (!employee) {
            if (staffName?.trim()) unmatched.add(staffName.trim());
            return;
          }

          const current = totals.get(employee.id);
          current.workedHours += shiftHours;
          current.rotaWorkedHours += shiftHours;
          current.dailyWorkedHours[day.date] = (current.dailyWorkedHours[day.date] || 0) + shiftHours;
          current.shiftsWorked += 1;
          current.shiftBreakdown.push({
            dayName: day.dayName,
            date: day.date,
            shift: shiftData.shift,
            hours: shiftHours,
            rotaName: staffName,
          });
        });
      });
    });

    totals.forEach((row) => {
      Object.keys(row.dailyWorkedHours).forEach((date) => {
        const key = `${row.employeeId}|${date}`;
        if (!actualHoursOverrideMap.has(key)) return;
        const rotaHoursForDate = Number(row.dailyWorkedHours[date] || 0);
        const actualHoursForDate = Number(actualHoursOverrideMap.get(key) || 0);
        row.workedHours += actualHoursForDate - rotaHoursForDate;
        row.actualHoursOverrideDates.push({ date, rotaHours: rotaHoursForDate, actualHours: actualHoursForDate });
      });
      actualHoursOverrideMap.forEach((actualHoursForDate, key) => {
        const [employeeId, date] = key.split("|");
        if (employeeId !== row.employeeId || Object.prototype.hasOwnProperty.call(row.dailyWorkedHours, date)) return;
        row.workedHours += Number(actualHoursForDate || 0);
        row.actualHoursOverrideDates.push({ date, rotaHours: 0, actualHours: Number(actualHoursForDate || 0) });
      });
    });

    const rows = Array.from(totals.values())
      .map((row) => ({
        ...row,
        accountedHours: row.workedHours + row.annualLeaveHours + row.adjustmentHours,
        varianceHours:
          row.workedHours + row.annualLeaveHours + row.adjustmentHours - row.contractedHours,
      }))
      .filter((row) => row.active || row.workedHours > 0 || row.sicknessHours > 0)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return {
      rows,
      unmatchedNames: Array.from(unmatched).sort((a, b) => a.localeCompare(b)),
    };
  }

  async function loadViewerUpcomingShifts(employeeId) {
    setViewerEmployeeId(employeeId);
    setViewerUpcomingShifts([]);
    setViewerPreviousShifts([]);
    setShowPreviousShifts(false);

    if (!employeeId) return;

    const viewerEmployeeList = isAdmin ? employees : staffDirectory;
    const employee = viewerEmployeeList.find((item) => item.id === employeeId);
    if (!employee) return;

    setViewerUpcomingShiftsLoading(true);

    try {
      const todayId = toDateId(new Date());

      // Only use weeks still present in the live rota collection. Once rota
      // maintenance moves a week into rotaArchive it is no longer in
      // visibleWeeks, so ordinary accounts cannot browse archived shifts here.
      const liveWeekIds = visibleWeeks
        .map((week) => normaliseWeekId(week))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));

      const resolvedWeeks = await Promise.all(
        liveWeekIds.map(async (weekId) => getResolvedPayrollDays(weekId))
      );

      const shifts = [];

      resolvedWeeks.flat().forEach((day) => {
        if (!day?.date) return;

        (day.shifts || []).forEach((shiftEntry) => {
          const matchesEmployee = (shiftEntry.staff || []).some((staffName) => {
            const resolved = resolvePayrollEmployee(staffName, viewerEmployeeList);
            return resolved?.id === employee.id;
          });

          if (!matchesEmployee) return;

          shifts.push({
            date: day.date,
            dayName: day.dayName || "",
            shift: shiftEntry.shift,
            note: shiftEntry.note || "",
          });
        });
      });

      function combineViewerShifts(sourceShifts) {
        const shiftsByDate = new Map();

        sourceShifts.forEach((shift) => {
          if (!shiftsByDate.has(shift.date)) shiftsByDate.set(shift.date, []);
          shiftsByDate.get(shift.date).push(shift);
        });

        const combinedShifts = [];

        shiftsByDate.forEach((dateShifts) => {
          const dayShift = dateShifts.find((item) => item.shift === "9am-5pm");
          const eveningShift = dateShifts.find((item) => item.shift === "5pm-10pm");
          const nightShift = dateShifts.find((item) => item.shift === "10pm-9am");

          const combineEntries = (first, second, label) => ({
            date: first.date,
            dayName: first.dayName || second.dayName || "",
            shift: label,
            note: [first.note, second.note]
              .map((note) => String(note || "").trim())
              .filter(Boolean)
              .filter((note, index, array) => array.indexOf(note) === index)
              .join(" · "),
          });

          if (dayShift && eveningShift) {
            combinedShifts.push(combineEntries(dayShift, eveningShift, "9am-10pm"));
          } else if (dayShift) {
            combinedShifts.push(dayShift);
          }

          if (eveningShift && nightShift) {
            if (!dayShift) {
              combinedShifts.push(combineEntries(eveningShift, nightShift, "5pm-9am"));
            } else {
              combinedShifts.push(nightShift);
            }
          } else {
            if (eveningShift && !dayShift) combinedShifts.push(eveningShift);
            if (nightShift) combinedShifts.push(nightShift);
          }

          dateShifts
            .filter(
              (item) =>
                item.shift !== "9am-5pm" &&
                item.shift !== "5pm-10pm" &&
                item.shift !== "10pm-9am"
            )
            .forEach((item) => combinedShifts.push(item));
        });

        return combinedShifts;
      }

      const shiftSortIndex = (shift) =>
        ["9am-10pm", "5pm-9am"].includes(shift)
          ? shift === "9am-10pm" ? 1 : 2
          : SHIFTS.indexOf(shift);

      const upcoming = combineViewerShifts(
        shifts.filter((item) => item.date >= todayId)
      ).sort(
        (a, b) =>
          a.date.localeCompare(b.date) || shiftSortIndex(a.shift) - shiftSortIndex(b.shift)
      );

      const previous = combineViewerShifts(
        shifts.filter((item) => item.date < todayId)
      ).sort(
        (a, b) =>
          b.date.localeCompare(a.date) || shiftSortIndex(a.shift) - shiftSortIndex(b.shift)
      );

      setViewerUpcomingShifts(upcoming);
      setViewerPreviousShifts(previous);
    } catch (error) {
      console.error("Failed to load shifts:", error);
      setViewerUpcomingShifts([]);
      setViewerPreviousShifts([]);
      alert("Shifts could not be loaded.");
    } finally {
      setViewerUpcomingShiftsLoading(false);
    }
  }

  async function getResolvedPayrollDays(weekId) {
    const archivedWeek = archiveWeeks.find(
      (week) => week.weekStart === weekId
    );

    if (archivedWeek?.days) {
      return archivedWeek.days;
    }

    const liveWeek = weeks.find(
      (week) => normaliseWeekId(week) === weekId
    );

    if (!liveWeek) {
      throw new Error("The selected payroll week could not be found.");
    }

    const baseRota = await getBaseRotaForWeek(weekId);
    const { overrideData } = await loadOverridesForWeek(weekId);

    return buildFlattenedArchiveDays(weekId, baseRota, overrideData, liveWeek.dayNotes || {});
  }

  function getPayrollWeekIdsForDateRange(startDate, endDate) {
    if (!startDate || !endDate || endDate < startDate) return [];

    return payrollWeekOptions
      .map((week) => week.weekStart)
      .filter((weekId) => {
        const weekEnd = toDateId(addDays(weekId, 6));
        return weekId <= endDate && weekEnd >= startDate;
      })
      .sort((a, b) => a.localeCompare(b));
  }

  function annualLeaveCoversDate(leave, dateId) {
    return (
      leave?.startDate &&
      leave?.endDate &&
      leave.startDate <= dateId &&
      leave.endDate >= dateId
    );
  }

  function contractHoursForDate(employee, dateId) {
    const history = Array.isArray(employee.contractHistory) ? employee.contractHistory : [];
    const effective = history.filter((item) => item.effectiveFrom <= dateId)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    return Number(effective?.hours ?? employee.baselineContractedHours ?? employee.contractedHours ?? 0);
  }

  async function buildPayrollContractAndLeaveHours(
    startDate,
    endDate,
    employeeList = employees
  ) {
    const contractedHoursByEmployee = new Map();
    const annualLeaveHoursByEmployee = new Map();
    const payrollAnnualLeave = isAdmin
      ? [...annualLeave, ...annualLeaveArchive]
      : annualLeave;

    employeeList.forEach((employee) => {
      contractedHoursByEmployee.set(employee.id, 0);
      annualLeaveHoursByEmployee.set(employee.id, 0);
    });

    const start = parseLocalDate(startDate);
    const end = parseLocalDate(endDate);
    const baseRotaCache = new Map();

    for (
      let cursor = new Date(start);
      cursor <= end;
      cursor.setDate(cursor.getDate() + 1)
    ) {
      const dateId = toDateId(cursor);
      const dayOfWeek = cursor.getDay();
      const dayIndex = dayOfWeek === 0 ? 7 : dayOfWeek;
      const monday = new Date(cursor);
      monday.setDate(cursor.getDate() - (dayIndex - 1));
      const weekId = toDateId(monday);

      let baseRota = baseRotaCache.get(weekId);
      if (!baseRota) {
        baseRota = await getBaseRotaForWeek(weekId);
        baseRotaCache.set(weekId, baseRota);
      }

      SHIFTS.forEach((shift) => {
        const shiftHours = PAYROLL_SHIFT_HOURS[shift];
        if (!Number.isFinite(shiftHours)) return;

        const baseStaff = baseRota?.[dayIndex]?.[shift]?.staff || [];

        baseStaff.forEach((staffName) => {
          const employee = resolvePayrollEmployee(staffName, employeeList);
          if (!employee) return;

          contractedHoursByEmployee.set(
            employee.id,
            (contractedHoursByEmployee.get(employee.id) || 0) + shiftHours
          );

          // Legacy fallback only: newer A/L records store confirmed paid hours
          // explicitly in leaveHoursByDate and are added below.
          const onLeave = payrollAnnualLeave.some(
            (leave) =>
              !leave?.leaveHoursByDate &&
              resolvePayrollEmployee(leave.staffName, employeeList)?.id ===
                employee.id && annualLeaveCoversDate(leave, dateId)
          );

          if (onLeave) {
            annualLeaveHoursByEmployee.set(
              employee.id,
              (annualLeaveHoursByEmployee.get(employee.id) || 0) + shiftHours
            );
          }
        });
      });
    }

    // New A/L records store confirmed paid leave hours by calendar date.
    // These values are authoritative for payroll and do not depend on the
    // base rota remaining representative of the employee's working pattern.
    payrollAnnualLeave.forEach((leave) => {
      if (!leave?.leaveHoursByDate) return;
      const employee = resolvePayrollEmployee(leave.staffName, employeeList);
      if (!employee) return;

      Object.entries(leave.leaveHoursByDate).forEach(([dateId, rawHours]) => {
        if (dateId < startDate || dateId > endDate) return;
        const hours = Number(rawHours);
        if (!Number.isFinite(hours) || hours <= 0) return;
        annualLeaveHoursByEmployee.set(
          employee.id,
          (annualLeaveHoursByEmployee.get(employee.id) || 0) + hours
        );
      });
    });

    // Preserve explicit weekly contractual hours for complete Monday-Sunday
    // weeks. Base-rota hours are used only for partial weeks, where a simple
    // fraction of the weekly contract would be misleading.
    const firstMonday =
      start.getDay() === 1 ? new Date(start) : addDays(toDateId(start), 8 - (start.getDay() || 7));
    const lastSunday =
      end.getDay() === 0 ? new Date(end) : addDays(toDateId(end), -end.getDay());

    let completeWeeks = 0;
    if (firstMonday <= lastSunday) {
      completeWeeks =
        Math.floor((lastSunday - firstMonday) / (7 * 24 * 60 * 60 * 1000)) + 1;
    }

    employeeList.forEach((employee) => {
      // Daily effective dates: prorate weekly contract across seven days.
      // A midweek change therefore affects only the days from its effective date.
      let fullWeekContractHours = 0;
      for (let cursor = new Date(firstMonday); cursor <= lastSunday; cursor.setDate(cursor.getDate() + 1)) {
        fullWeekContractHours += contractHoursForDate(employee, toDateId(cursor)) / 7;
      }

      let partialBaseHours = 0;
      const rangeStart = parseLocalDate(startDate);
      const rangeEnd = parseLocalDate(endDate);
      for (let cursor = new Date(rangeStart); cursor <= rangeEnd; cursor.setDate(cursor.getDate() + 1)) {
        const inCompleteWeek = firstMonday <= lastSunday && cursor >= firstMonday && cursor <= lastSunday;
        if (inCompleteWeek) continue;
        const dayIndex = cursor.getDay() || 7;
        const weekId = toDateId(addDays(toDateId(cursor), -(dayIndex - 1)));
        const baseRota = baseRotaCache.get(weekId) || {};
        SHIFTS.forEach((shift) => {
          const shiftHours = PAYROLL_SHIFT_HOURS[shift];
          const baseStaff = baseRota?.[dayIndex]?.[shift]?.staff || [];
          if (Number.isFinite(shiftHours) && baseStaff.some((staffName) =>
            resolvePayrollEmployee(staffName, employeeList)?.id === employee.id)) partialBaseHours += shiftHours;
        });
      }
      contractedHoursByEmployee.set(employee.id, fullWeekContractHours + partialBaseHours);
    });

    // Cap A/L credited in each complete Monday-Sunday payroll week at the
    // employee's contracted weekly hours. This prevents regular overtime
    // shifts that appear in the base rota from inflating full-week A/L.
    //
    // Partial-week A/L is intentionally left unchanged for now; its treatment
    // can be refined separately once the desired business rule is agreed.
    if (completeWeeks > 0) {
      employeeList.forEach((employee) => {
        let maximumLeaveHours = 0;
        for (let cursor = new Date(firstMonday); cursor <= lastSunday; cursor.setDate(cursor.getDate() + 1)) {
          maximumLeaveHours += contractHoursForDate(employee, toDateId(cursor)) / 7;
        }
        const currentLeaveHours = Number(
          annualLeaveHoursByEmployee.get(employee.id) || 0
        );
        annualLeaveHoursByEmployee.set(
          employee.id,
          Math.min(currentLeaveHours, maximumLeaveHours)
        );
      });
    }

    return { contractedHoursByEmployee, annualLeaveHoursByEmployee };
  }

  async function generatePayrollPreview() {
    if (!isEditor) return;
    if (["employees", "annualLeave", "annualLeaveArchive", "payrollAdjustments", "sickness", "archive"].some((key) => loadStatus[key] !== "ready")) {
      alert("Payroll cannot be calculated until all required records have loaded. Please retry any failed sections.");
      return;
    }

    if (payrollMode === "weekly" && !payrollWeek) return;

    if (payrollMode === "range") {
      if (!payrollStartDate || !payrollEndDate) {
        alert("Choose a payroll start date and end date.");
        return;
      }
      if (payrollEndDate < payrollStartDate) {
        alert("The payroll end date cannot be before the start date.");
        return;
      }
    }

    setPayrollPreviewLoading(true);

    try {
      let days = [];
      let periodStart = "";
      let periodEnd = "";
      let label = "";

      if (payrollMode === "weekly") {
        days = await getResolvedPayrollDays(payrollWeek);
        periodStart = payrollWeek;
        periodEnd = toDateId(addDays(payrollWeek, 6));
        label = `W/C ${formatWeekCommencing(payrollWeek)}`;
      } else {
        const weekIds = getPayrollWeekIdsForDateRange(
          payrollStartDate,
          payrollEndDate
        );

        if (weekIds.length === 0) {
          throw new Error("No rota data overlaps the selected date range.");
        }

        const resolvedWeeks = await Promise.all(
          weekIds.map((weekId) => getResolvedPayrollDays(weekId))
        );

        days = resolvedWeeks
          .flat()
          .filter(
            (day) => day.date >= payrollStartDate && day.date <= payrollEndDate
          );

        periodStart = payrollStartDate;
        periodEnd = payrollEndDate;
        label = `${formatAnnualLeaveDate(payrollStartDate)} to ${formatAnnualLeaveDate(payrollEndDate)}`;
      }

      const {
        contractedHoursByEmployee,
        annualLeaveHoursByEmployee,
      } = await buildPayrollContractAndLeaveHours(
        periodStart,
        periodEnd,
        employees
      );

      const adjustmentHoursByEmployee = getAdjustmentHoursForPeriod(
        periodStart,
        periodEnd,
        employees
      );

      const actualHoursOverrideMap = getActualHoursOverridesForPeriod(periodStart, periodEnd);

      const result = buildPayrollPreviewFromDays(
        days,
        employees,
        contractedHoursByEmployee,
        annualLeaveHoursByEmployee,
        adjustmentHoursByEmployee,
        actualHoursOverrideMap,
        sicknessHoursForPeriod(periodStart, periodEnd)
      );
      setPayrollShadows(days.flatMap((day) => (day.shifts || []).flatMap((shift) =>
        (shift.staff || []).filter(isShadow).map((name) => ({
          date: day.date, shift: shift.shift,
          name: resolvePayrollEmployee(name, employees)?.displayName || stripShadow(name),
        }))
      )));
      setPayrollPreview(result.rows);
      setPayrollUnmatchedNames(result.unmatchedNames);
      setPayrollPeriodLabel(label);
    } catch (error) {
      console.error("Failed to generate payroll preview:", error);
      setPayrollPreview([]);
      setPayrollShadows([]);
      setPayrollUnmatchedNames([]);
      setPayrollPeriodLabel("");
      alert(error.message || "Payroll preview could not be generated.");
    } finally {
      setPayrollPreviewLoading(false);
    }
  }

  function handlePayrollPdf() {
    if (payrollPreview.length === 0) {
      alert("Calculate the payroll hours before creating the PDF.");
      return;
    }

    try {
      const periodStart =
        payrollMode === "weekly" ? payrollWeek : payrollStartDate;
      const periodEnd =
        payrollMode === "weekly"
          ? (payrollWeek ? toDateId(addDays(payrollWeek, 6)) : "")
          : payrollEndDate;

      const periodAdjustments = payrollAdjustments
        .filter(
          (adjustment) =>
            adjustment.date >= periodStart && adjustment.date <= periodEnd
        )
        .sort((a, b) => a.date.localeCompare(b.date));

      const periodSickness = sicknessAbsences.filter((item) => item.startDate <= periodEnd && item.endDate >= periodStart);

      const periodOverrides = actualHoursOverrides
        .filter(
          (override) =>
            override.date >= periodStart && override.date <= periodEnd
        )
        .sort((a, b) => a.date.localeCompare(b.date));

      const previewByEmployee = new Map(
        payrollPreview.map((row) => [row.employeeId, row])
      );

      // Build the PDF directly rather than invoking the browser print dialog.
      // Orientation is explicitly portrait, so this is independent of printer/
      // browser print settings.
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
      });

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 12;
      const contentWidth = pageWidth - margin * 2;

      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(18);
      pdf.text("LONGCROFT Payroll Hours", pageWidth / 2, 16, { align: "center" });
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(11);
      pdf.text(payrollPeriodLabel || "Payroll period", pageWidth / 2, 22, { align: "center" });

      let tableStartY = 29;

      if (payrollUnmatchedNames.length > 0) {
        pdf.setFontSize(9);
        pdf.setFont("helvetica", "bold");
        pdf.text("Unmatched rota names:", margin, tableStartY);
        pdf.setFont("helvetica", "normal");
        const unmatchedLines = pdf.splitTextToSize(
          payrollUnmatchedNames.join(", "),
          contentWidth - 2
        );
        pdf.text(unmatchedLines, margin, tableStartY + 4);
        tableStartY += 5 + unmatchedLines.length * 4;
      }

      const head = [[
        "Employee",
        "Shifts",
        "Worked",
        "A/L",
        ...(payrollPeriodHasSickness ? ["Sick*"] : []),
        ...(payrollPeriodHasAdjustments ? ["Adj."] : []),
        "Accounted",
        "Contract",
        "Variance",
      ]];

      const body = payrollPreview.map((row) => [
        row.displayName,
        String(row.shiftsWorked),
        `${row.workedHours}h`,
        `${row.annualLeaveHours}h`,
        ...(payrollPeriodHasSickness ? [`${row.sicknessHours}h`] : []),
        ...(payrollPeriodHasAdjustments
          ? [`${row.adjustmentHours > 0 ? "+" : ""}${row.adjustmentHours}h`]
          : []),
        `${row.accountedHours}h`,
        `${Number(row.contractedHours.toFixed(2))}h`,
        `${row.varianceHours > 0 ? "+" : ""}${Number(row.varianceHours.toFixed(2))}h`,
      ]);

      autoTable(pdf, {
        startY: tableStartY,
        head,
        body,
        theme: "grid",
        margin: { left: margin, right: margin, bottom: 18 },
        styles: {
          font: "helvetica",
          fontSize: 8.2,
          cellPadding: 2.2,
          lineWidth: 0.2,
          lineColor: [90, 90, 90],
          textColor: [34, 34, 34],
          valign: "middle",
        },
        headStyles: {
          fillColor: [238, 231, 220],
          textColor: [34, 34, 34],
          fontStyle: "bold",
        },
        columnStyles: {
          0: { cellWidth: 42, halign: "left" },
          1: { halign: "right" },
          2: { halign: "right" },
          3: { halign: "right" },
          4: { halign: "right" },
          5: { halign: "right" },
          6: { halign: "right" },
          7: { halign: "right" },
        },
      });

      let cursorY = (pdf.lastAutoTable?.finalY || tableStartY) + 8;

      const ensureSpace = (neededHeight = 16) => {
        if (cursorY + neededHeight <= pageHeight - 16) return;
        pdf.addPage("a4", "portrait");
        cursorY = 16;
      };

      const addSectionHeading = (heading) => {
        ensureSpace(12);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(11);
        pdf.text(heading, margin, cursorY);
        cursorY += 6;
      };

      const addNote = (text) => {
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8.5);
        const lines = pdf.splitTextToSize(text, contentWidth - 4);
        const noteHeight = Math.max(5, lines.length * 3.8 + 2);
        ensureSpace(noteHeight);
        pdf.text("•", margin, cursorY);
        pdf.text(lines, margin + 4, cursorY);
        cursorY += noteHeight;
      };

      if (periodOverrides.length > 0 || periodAdjustments.length > 0 || periodSickness.length > 0 || payrollShadows.length > 0) {
        addSectionHeading("Payroll Notes / Exceptions");
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8.5);
        pdf.text(
          "Payroll exceptions and absence information for the selected period.",
          margin,
          cursorY
        );
        cursorY += 6;
      }

      if (payrollShadows.length > 0) {
        addSectionHeading("Shadow Shifts");
        addNote("Shadow annotations are informational. The listed shifts remain included in rota-derived hours.");
        [...payrollShadows].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
          .forEach(({ date, name, shift }) => addNote(`${formatAnnualLeaveDate(date)} - ${name} (Shadow) - ${shift.replace(/\n/g, " ")}`));
      }

      if (periodSickness.length > 0) {
        addSectionHeading("Sickness Absence");
        addNote("*Information only - Sickness hours are excluded from Accounted hours and Variance calculation.");

        periodSickness
          .slice()
          .sort((a, b) => a.startDate.localeCompare(b.startDate) ||
            (a.displayName || "").localeCompare(b.displayName || ""))
          .forEach((record) => {
            const fullPeriodDays = getAnnualLeaveDateIds(record.startDate, record.endDate).length;
            const allConfirmedEntries = Object.entries(record.absenceHoursByDate || {});
            const periodShifts = allConfirmedEntries
              .filter(([date, value]) => date >= periodStart && date <= periodEnd &&
                Number.isFinite(Number(value)) && Number(value) > 0)
              .sort(([a], [b]) => a.localeCompare(b));
            const periodHours = periodShifts.reduce((sum, [, value]) => sum + Number(value), 0);
            const fullEpisodeHours = allConfirmedEntries.reduce((sum, [, value]) =>
              sum + (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0), 0);
            const episodeWithinPeriod = record.startDate >= periodStart && record.endDate <= periodEnd;
            const displayName = record.displayName ||
              employees.find((employee) => employee.id === record.employeeId)?.displayName ||
              "Unknown employee";

            // Reserve room for the employee heading and first row, avoiding
            // a heading stranded at the foot of a PDF page.
            ensureSpace(32);
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(9.5);
            pdf.text(displayName, margin, cursorY);
            cursorY += 5;
            addNote(`Full recorded sickness period: ${formatAnnualLeaveDate(record.startDate)} to ${formatAnnualLeaveDate(record.endDate)} (${fullPeriodDays} calendar days).`);
            addNote(`Selected payroll period: ${formatAnnualLeaveDate(periodStart)} to ${formatAnnualLeaveDate(periodEnd)} - ${Number(periodHours.toFixed(2))}h missed.`);
            if (!episodeWithinPeriod) {
              addNote(`Whole recorded episode: ${Number(fullEpisodeHours.toFixed(2))}h confirmed missed (includes dates outside this payroll period).`);
            }
            if (record.note?.trim()) addNote(`Administrative note: ${record.note.trim()}`);

            if (periodShifts.length > 0) {
              autoTable(pdf, {
                startY: cursorY + 1,
                head: [["Affected scheduled shift", "Confirmed hours missed"]],
                body: [
                  ...periodShifts.map(([date, value]) => [
                    formatAnnualLeaveDate(date),
                    `${Number(Number(value).toFixed(2))}h`,
                  ]),
                  ["Total within payroll period", `${Number(periodHours.toFixed(2))}h`],
                ],
                theme: "grid",
                margin: { left: margin + 4, right: margin + 76, bottom: 18 },
                styles: { font: "helvetica", fontSize: 7.8, cellPadding: { top: 1.1, bottom: 1.1, left: 1.5, right: 1.5 },
                  lineWidth: 0.15, lineColor: [120, 120, 120], textColor: [34, 34, 34] },
                headStyles: { fillColor: [238, 231, 220], textColor: [34, 34, 34], fontStyle: "bold" },
                columnStyles: { 1: { halign: "right", cellWidth: 43 } },
                didParseCell: (data) => {
                  if (data.section === "body" && data.row.index === periodShifts.length) {
                    data.cell.styles.fontStyle = "bold";
                  }
                },
              });
              cursorY = (pdf.lastAutoTable?.finalY || cursorY) + 7;
            } else {
              addNote("No confirmed missed scheduled shifts within this payroll period.");
              cursorY += 3;
            }
          });
      }

      if (periodOverrides.length > 0) {
        addSectionHeading("Actual Hours Overrides");
        periodOverrides.forEach((override) => {
          const previewRow = previewByEmployee.get(override.employeeId);
          const appliedOverride = previewRow?.actualHoursOverrideDates?.find(
            (item) => item.date === override.date
          );
          const displayName =
            override.displayName ||
            employees.find((employee) => employee.id === override.employeeId)
              ?.displayName ||
            "Unknown employee";
          const rotaHours = Number(appliedOverride?.rotaHours ?? 0);
          const actualHours = Number(
            appliedOverride?.actualHours ?? override.hours ?? 0
          );
          const reason = override.note?.trim()
            ? ` — ${override.note.trim()}`
            : "";

          addNote(
            `${formatAnnualLeaveDate(override.date)} — ${displayName}: ` +
            `rota ${rotaHours}h -> actual ${actualHours}h${reason}`
          );
        });
      }

      if (periodAdjustments.length > 0) {
        addSectionHeading("Payroll Adjustments");
        periodAdjustments.forEach((adjustment) => {
          const employeeNames = (adjustment.employees || [])
            .map((selected) => selected.displayName)
            .filter(Boolean)
            .join(", ");
          const hours = Number(adjustment.hours || 0);
          const reason = adjustment.note?.trim()
            ? ` — ${adjustment.note.trim()}`
            : "";

          addNote(
            `${formatAnnualLeaveDate(adjustment.date)} — +${hours}h` +
            `${employeeNames ? ` — ${employeeNames}` : ""}${reason}`
          );
        });
      }

      const generatedText = `Generated ${new Date().toLocaleString("en-GB")}. Hours are derived from the rota and employee register, including any listed manual payroll adjustments or actual-hours overrides.`;
      const totalPages = pdf.getNumberOfPages();

      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
        pdf.setPage(pageNumber);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(7.5);
        pdf.setTextColor(90, 90, 90);
        pdf.text(
          generatedText,
          margin,
          pageHeight - 8,
          { maxWidth: contentWidth - 18 }
        );
        pdf.text(
          `${pageNumber}/${totalPages}`,
          pageWidth - margin,
          pageHeight - 8,
          { align: "right" }
        );
      }

      const safePeriodLabel = String(payrollPeriodLabel || `${periodStart} to ${periodEnd}`)
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "");

      pdf.save(`Longcroft-Payroll-${safePeriodLabel || "Hours"}.pdf`);
    } catch (error) {
      console.error("Failed to create payroll PDF:", error);
      alert("The payroll PDF could not be created. Check that the PDF dependencies are installed, then try again.");
    }
  }

  async function loadAnnualLeave() {
    if (!user) {
      setAnnualLeave([]);
      return [];
    }

    setAnnualLeaveLoading(true);

    try {
      const snapshot = await getDocs(collection(db, "annualLeave"));
      const loadedLeave = snapshot.docs
        .map((leaveDoc) => ({ id: leaveDoc.id, ...leaveDoc.data() }))
        .filter((leave) => leave.staffName && leave.startDate && leave.endDate)
        .sort((a, b) =>
          a.startDate.localeCompare(b.startDate) ||
          a.staffName.localeCompare(b.staffName)
        );

      setAnnualLeave(loadedLeave);
      return loadedLeave;
    } catch (error) {
      console.error("Failed to load annual leave reminders:", error);
      throw error;
    } finally {
      setAnnualLeaveLoading(false);
    }
  }


  async function loadAnnualLeaveArchive() {
    if (!isAdmin) {
      setAnnualLeaveArchive([]);
      return [];
    }

    try {
      const snapshot = await getDocs(collection(db, "annualLeaveArchive"));
      const loadedArchive = snapshot.docs
        .map((leaveDoc) => ({ id: leaveDoc.id, ...leaveDoc.data() }))
        .filter((leave) => leave.staffName && leave.startDate && leave.endDate)
        .sort((a, b) =>
          b.endDate.localeCompare(a.endDate) ||
          a.staffName.localeCompare(b.staffName)
        );

      setAnnualLeaveArchive(loadedArchive);
      return loadedArchive;
    } catch (error) {
      console.error("Failed to load annual leave archive:", error);
      setAnnualLeaveArchive([]);
      return [];
    }
  }

  async function archivePreviousCalendarYearAnnualLeave() {
    if (!isAdmin) return [];

    const todayId = toDateId(new Date());
    const currentYearStart = `${new Date().getFullYear()}-01-01`;
    const snapshot = await getDocs(collection(db, "annualLeave"));

    // Normal records from previous calendar years are moved on/after 1 January.
    // A leave period spanning New Year stays live until it has actually ended,
    // then moves as one intact record rather than being split across collections.
    const toArchive = snapshot.docs.filter((leaveDoc) => {
      const leave = leaveDoc.data();
      return (
        leave?.startDate &&
        leave?.endDate &&
        leave.startDate < currentYearStart &&
        leave.endDate < todayId
      );
    });

    if (toArchive.length === 0) return [];

    const batch = writeBatch(db);
    const archivedAt = new Date().toISOString();

    toArchive.forEach((leaveDoc) => {
      const leave = leaveDoc.data();
      const archiveYear = Number(String(leave.endDate).slice(0, 4));

      batch.set(doc(db, "annualLeaveArchive", leaveDoc.id), {
        ...leave,
        originalAnnualLeaveId: leaveDoc.id,
        archiveYear: Number.isFinite(archiveYear) ? archiveYear : null,
        archivedAt,
        archivedBy: user?.email || "unknown",
        archiveReason: "calendar-year-rollover",
      });
      batch.delete(leaveDoc.ref);
    });

    await batch.commit();
    return toArchive.map((leaveDoc) => leaveDoc.id);
  }
  function getAnnualLeaveDateIds(startDate = annualLeaveStartDate, endDate = annualLeaveEndDate) {
    if (!startDate || !endDate || endDate < startDate) return [];
    const dates = [];
    for (let cursor = parseLocalDate(startDate); cursor <= parseLocalDate(endDate); cursor.setDate(cursor.getDate() + 1)) {
      dates.push(toDateId(cursor));
    }
    return dates;
  }

  function getEmployeeHoursFromResolvedDay(day, employee) {
    if (!day || !employee) return 0;
    return (day.shifts || []).reduce((total, shiftData) => {
      const shiftHours = Number(PAYROLL_SHIFT_HOURS[shiftData.shift] || 0);
      if (!Number.isFinite(shiftHours)) return total;
      const staff = shiftData.staff || [];
      const included = staff.some(
        (name) => resolvePayrollEmployee(name)?.id === employee.id
      );
      return total + (included ? shiftHours : 0);
    }, 0);
  }

  function getEmployeeHoursFromBaseDay(baseRota, dayIndex, employee) {
    if (!employee) return 0;
    return SHIFTS.reduce((total, shift) => {
      const staff = baseRota?.[dayIndex]?.[shift]?.staff || [];
      const included = staff.some(
        (name) => resolvePayrollEmployee(name)?.id === employee.id
      );
      return total + (included ? Number(PAYROLL_SHIFT_HOURS[shift] || 0) : 0);
    }, 0);
  }

  function getEmployeeBaseShiftCount(baseRota, dayIndex, employee) {
    if (!employee) return 0;
    return SHIFTS.reduce((count, shift) => {
      const staff = baseRota?.[dayIndex]?.[shift]?.staff || [];
      const included = staff.some(
        (name) => resolvePayrollEmployee(name)?.id === employee.id
      );
      return count + (included ? 1 : 0);
    }, 0);
  }

  async function suggestAnnualLeaveHours() {
    const staffName = annualLeaveName.trim();
    const employee = resolvePayrollEmployee(staffName);
    const dateIds = getAnnualLeaveDateIds();

    if (!staffName || !employee || dateIds.length === 0) {
      alert("Enter a recognised staff name and valid leave dates first.");
      return;
    }

    setAnnualLeaveHoursLoading(true);
    try {
      const baseCache = new Map();
      const resolvedCache = new Map();
      const suggested = {};
      const details = {};

      for (const dateId of dateIds) {
        const date = parseLocalDate(dateId);
        const dayIndex = date.getDay() === 0 ? 7 : date.getDay();
        const monday = new Date(date);
        monday.setDate(date.getDate() - (dayIndex - 1));
        const weekId = toDateId(monday);

        if (!baseCache.has(weekId)) {
          baseCache.set(weekId, await getBaseRotaForWeek(weekId));
        }
        const baseHours = getEmployeeHoursFromBaseDay(
          baseCache.get(weekId),
          dayIndex,
          employee
        );
        const baseShiftCount = getEmployeeBaseShiftCount(
          baseCache.get(weekId),
          dayIndex,
          employee
        );

        const hasFinalRota =
          archiveWeeks.some((week) => week.weekStart === weekId && week.days) ||
          weeks.some((week) => normaliseWeekId(week) === weekId);

        let finalHours = null;
        if (hasFinalRota) {
          if (!resolvedCache.has(weekId)) {
            resolvedCache.set(weekId, await getResolvedPayrollDays(weekId));
          }
          const resolvedDay = resolvedCache
            .get(weekId)
            .find((day) => day.date === dateId || day.dayIndex === dayIndex);
          finalHours = getEmployeeHoursFromResolvedDay(resolvedDay, employee);
        }

        // Normal A/L cover often removes the absent employee from the final rota.
        // That alone is not suspicious: use the base shift as the suggestion.
        // Raise review attention for genuinely unusual evidence, especially
        // multiple base shifts on one day or a changed non-zero final pattern.
        let value = "";
        let status = "No rota evidence";
        let review = false;

        if (baseShiftCount > 1 && baseHours > 0) {
          value = baseHours;
          status = `Base has ${baseShiftCount} shifts — check hours`;
          review = true;
        } else if (finalHours !== null && finalHours > 0) {
          value = finalHours;
          if (finalHours === baseHours) {
            status = "Final rota agrees";
          } else {
            status = "Final/base differ — check hours";
            review = true;
          }
        } else if (finalHours === 0 && baseHours > 0) {
          value = baseHours;
          status = "Covered/removed from final rota";
        } else if (finalHours === null && baseHours > 0) {
          value = baseHours;
          status = "Base rota only";
        } else if (finalHours === 0 && baseHours === 0) {
          value = 0;
          status = "No scheduled hours found";
        } else if (finalHours === null && baseHours === 0) {
          // No published/final rota exists yet and the base rota contains no
          // scheduled hours for this employee. Store an explicit 0 rather than
          // leaving the field blank: the UI previously showed the 0 placeholder
          // while saveAnnualLeaveReminder still treated the date as unconfirmed.
          value = 0;
          status = "No rota evidence — 0h assumed";
        }

        suggested[dateId] = value;
        details[dateId] = { baseHours, finalHours, baseShiftCount, status, review };
      }

      setAnnualLeaveHoursByDate(suggested);
      setAnnualLeaveSuggestionDetails(details);
    } catch (error) {
      console.error("Failed to compare annual leave rota hours:", error);
      alert("A/L rota comparison could not be completed. You can still enter the hours manually.");
    } finally {
      setAnnualLeaveHoursLoading(false);
    }
  }

  function clearAnnualLeaveForm() {
    setAllowRetrospectiveAnnualLeave(false);
    setEditingAnnualLeaveId("");
    setAnnualLeaveName("");
    setAnnualLeaveStartDate("");
    setAnnualLeaveEndDate("");
    setAnnualLeaveNote("");
    setAnnualLeaveHoursByDate({});
    setAnnualLeaveSuggestionDetails({});
  }

  function editAnnualLeaveReminder(leave) {
    if (!isEditor || !leave?.id) return;
    setAllowRetrospectiveAnnualLeave(false);
    setEditingAnnualLeaveId(leave.id);
    setAnnualLeaveName(leave.staffName || "");
    setAnnualLeaveStartDate(leave.startDate || "");
    setAnnualLeaveEndDate(leave.endDate || leave.startDate || "");
    setAnnualLeaveNote(leave.note || "");
    setAnnualLeaveHoursByDate(leave.leaveHoursByDate || {});
    setAnnualLeaveSuggestionDetails({});
  }

  async function saveAnnualLeaveReminder(event) {
    event.preventDefault();
    if (!isEditor) return;

    const staffName = annualLeaveName.trim();
    const note = annualLeaveNote.trim();

    if (!staffName || !annualLeaveStartDate || !annualLeaveEndDate) {
      alert("Enter a staff name, start date and end date.");
      return;
    }

    const todayId = toDateId(new Date());

    if (!editingAnnualLeaveId && annualLeaveStartDate < todayId && !(isAdmin && allowRetrospectiveAnnualLeave)) {
      alert("Annual leave reminders cannot be created for dates in the past.");
      return;
    }

    if (annualLeaveEndDate < annualLeaveStartDate) {
      alert("The annual leave end date cannot be before the start date.");
      return;
    }

    const employee = resolvePayrollEmployee(staffName);
    if (!employee) {
      alert("Select a staff name that matches the employee register before saving paid A/L hours.");
      return;
    }

    const dateIds = getAnnualLeaveDateIds();
    const confirmedHoursByDate = {};
    for (const dateId of dateIds) {
      const rawHours = annualLeaveHoursByDate[dateId];
      if (rawHours === "" || rawHours === undefined || rawHours === null) {
        alert(`Confirm the A/L hours for ${formatAnnualLeaveDate(dateId)} before saving.`);
        return;
      }
      const hours = Number(rawHours);
      if (!Number.isFinite(hours) || hours < 0) {
        alert(`Enter valid A/L hours for ${formatAnnualLeaveDate(dateId)}.`);
        return;
      }
      confirmedHoursByDate[dateId] = hours;
    }

    // Guardrail: confirmed A/L within any Monday-Sunday week must not exceed
    // the employee's contracted weekly hours.
    const weeklyTotals = new Map();
    dateIds.forEach((dateId) => {
      const date = parseLocalDate(dateId);
      const dayIndex = date.getDay() === 0 ? 7 : date.getDay();
      const monday = new Date(date);
      monday.setDate(date.getDate() - (dayIndex - 1));
      const weekId = toDateId(monday);
      weeklyTotals.set(weekId, (weeklyTotals.get(weekId) || 0) + Number(confirmedHoursByDate[dateId] || 0));
    });
    const weeklyContract = Number(employee.contractedHours || 0);
    for (const [weekId, hours] of weeklyTotals) {
      if (weeklyContract > 0 && hours > weeklyContract) {
        alert(`A/L for W/C ${formatWeekCommencing(weekId)} totals ${hours}h, above ${employee.displayName}'s ${weeklyContract}h weekly contract.`);
        return;
      }
    }

    const leaveHours = Object.values(confirmedHoursByDate).reduce((sum, hours) => sum + Number(hours || 0), 0);

    try {
      const payload = {
        staffName,
        startDate: annualLeaveStartDate,
        endDate: annualLeaveEndDate,
        leaveHoursByDate: confirmedHoursByDate,
        leaveHours,
        hoursSource: "admin-confirmed",
        note,
        updatedAt: new Date().toISOString(),
        updatedBy: user?.email || "unknown",
      };

      if (editingAnnualLeaveId) {
        await auditedWrite(doc(db, "annualLeave", editingAnnualLeaveId), payload, { merge: true });
      } else {
        await auditedWrite(doc(collection(db, "annualLeave")), {
          ...payload,
          createdAt: new Date().toISOString(),
          createdBy: user?.email || "unknown",
        });
      }

      clearAnnualLeaveForm();
      await loadAnnualLeave();
    } catch (error) {
      console.error("Failed to save annual leave reminder:", error);
      alert("Annual leave reminder could not be saved.");
    }
  }

  async function deleteAnnualLeaveReminder(leaveId) {
    if (!isEditor || !leaveId) return;

    if (!window.confirm("Delete this annual leave reminder?")) return;

    try {
      await auditedWrite(doc(db, "annualLeave", leaveId), null, { delete: true });
      await loadAnnualLeave();
    } catch (error) {
      console.error("Failed to delete annual leave reminder:", error);
      alert("Annual leave reminder could not be deleted.");
    }
  }

  async function loadOverridesForWeek(weekId) {
    const snapshot = await getDocs(
      collection(db, "rotaWeeks", weekId, "overrides")
    );

    const overrideData = {};

    snapshot.forEach((overrideDoc) => {
      const data = overrideDoc.data();

      if (data.active === false) return;

      if (!overrideData[data.dayIndex]) {
        overrideData[data.dayIndex] = {};
      }

      overrideData[data.dayIndex][data.shift] = data;
    });

    return { overrideData, snapshot };
  }

  function buildFlattenedArchiveDays(weekId, baseRota, overrideData, dayNotes = {}) {
    return DAYS.map((day) => ({
      dayIndex: day.dayIndex,
      dayName: day.name,
      date: toDateId(addDays(weekId, day.dayIndex - 1)),
      dayNote: dayNotes?.[day.dayIndex] || dayNotes?.[String(day.dayIndex)] || "",
      shifts: SHIFTS.map((shift, sortOrder) => {
        const override = overrideData?.[day.dayIndex]?.[shift];
        const baseStaff = baseRota?.[day.dayIndex]?.[shift]?.staff || [];

        return {
          shift,
          sortOrder,
          staff: override?.staff ?? baseStaff,
          vacantSlots: Number(override?.vacantSlots ?? baseRota?.[day.dayIndex]?.[shift]?.vacantSlots ?? 0),
          note: override?.note || "",
        };
      }),
    }));
  }

  function archiveDocumentLooksValid(archiveData, weekId) {
    return (
      archiveData?.schemaVersion === ARCHIVE_SCHEMA_VERSION &&
      archiveData?.weekStart === weekId &&
      Array.isArray(archiveData?.days) &&
      archiveData.days.length === DAYS.length &&
      archiveData.days.every(
        (day) =>
          Array.isArray(day.shifts) &&
          day.shifts.length === SHIFTS.length
      )
    );
  }

  async function deleteLiveWeekAfterArchive(weekId, overridesSnapshot) {
    const batch = writeBatch(db);

    overridesSnapshot.docs.forEach((overrideDoc) => {
      batch.delete(overrideDoc.ref);
    });

    batch.delete(doc(db, "rotaWeeks", weekId));
    await batch.commit();
  }

  async function archiveSingleWeek(week, versions) {
    const weekId = normaliseWeekId(week);
    if (!weekId) throw new Error("Rota week has no valid week identifier.");

    const archiveRef = doc(db, "rotaArchive", weekId);
    const existingArchive = await getDoc(archiveRef);
    const { overrideData, snapshot: overridesSnapshot } =
      await loadOverridesForWeek(weekId);

    if (existingArchive.exists()) {
      if (!archiveDocumentLooksValid(existingArchive.data(), weekId)) {
        throw new Error(
          `Existing archive ${weekId} failed validation; live data was not deleted.`
        );
      }

      await deleteLiveWeekAfterArchive(weekId, overridesSnapshot);
      return { weekId, action: "verified-existing-and-deleted-live" };
    }

    const applicableVersion = findApplicableBaseVersion(weekId, versions);
    const baseRota = await getBaseRotaForWeek(weekId, versions);
    const flattenedDays = buildFlattenedArchiveDays(
      weekId,
      baseRota,
      overrideData,
      week.dayNotes || {}
    );

    const archiveData = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      weekId,
      weekStart: weekId,
      weekEnd: toDateId(addDays(weekId, 6)),
      title: week.title || "LONGCROFT Staff Rota",
      status: "archived",
      days: flattenedDays,
      baseVersionId: applicableVersion?.id || "legacy-originalPattern",
      baseVersionEffectiveFrom:
        applicableVersion?.effectiveFrom || null,
      sourceMetadata: {
        liveWeekDocumentId: week.id || weekId,
        hadOverrides: overridesSnapshot.size > 0,
        archiveFormat: "resolved-final-rota",
      },
      archivedAt: new Date().toISOString(),
      archivedBy: user?.email || "unknown",
      archiveSource: "admin-login",
    };

    await setDoc(archiveRef, archiveData);

    const verificationSnapshot = await getDoc(archiveRef);

    if (
      !verificationSnapshot.exists() ||
      !archiveDocumentLooksValid(verificationSnapshot.data(), weekId)
    ) {
      throw new Error(
        `Archive verification failed for ${weekId}; live data was not deleted.`
      );
    }

    await deleteLiveWeekAfterArchive(weekId, overridesSnapshot);
    return { weekId, action: "created-verified-and-deleted-live" };
  }

  async function archiveExpiredWeeks(existingWeeks, versions) {
    const expiredWeeks = existingWeeks
      .filter((week) => normaliseWeekId(week) < oldestLiveWeekId)
      .sort((a, b) =>
        normaliseWeekId(a).localeCompare(normaliseWeekId(b))
      );

    const archived = [];

    for (const week of expiredWeeks) {
      const result = await archiveSingleWeek(week, versions);
      archived.push(result);
    }

    return archived;
  }

  async function deleteBaseVersion(versionId) {
    const shiftsSnapshot = await getDocs(
      collection(db, "baseTemplateVersions", versionId, "shifts")
    );
    const week2Snapshot = await getDocs(
      collection(db, "baseTemplateVersions", versionId, "week2Shifts")
    );

    const batch = writeBatch(db);
    shiftsSnapshot.docs.forEach((shiftDoc) => batch.delete(shiftDoc.ref));
    week2Snapshot.docs.forEach((shiftDoc) => batch.delete(shiftDoc.ref));
    batch.delete(doc(db, "baseTemplateVersions", versionId));
    await batch.commit();
  }

  async function pruneObsoleteBaseVersions(versions) {
    const sortedVersions = [...versions]
      .filter((version) => version.effectiveFrom)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

    const anchorVersion = [...sortedVersions]
      .filter((version) => version.effectiveFrom <= oldestLiveWeekId)
      .pop();

    if (!anchorVersion) return [];

    const obsoleteVersions = sortedVersions.filter(
      (version) =>
        version.effectiveFrom < anchorVersion.effectiveFrom
    );

    for (const version of obsoleteVersions) {
      await deleteBaseVersion(version.id);
    }

    return obsoleteVersions.map((version) => version.id);
  }

  async function runRotaMaintenance(existingWeeks, versions) {
    const archived = await archiveExpiredWeeks(existingWeeks, versions);
    const archivedAnnualLeave = await archivePreviousCalendarYearAnnualLeave();
    const deletedBaseVersions = await pruneObsoleteBaseVersions(versions);

    return { archived, archivedAnnualLeave, deletedBaseVersions };
  }

  async function loadBaseRotaForSelectedWeek(
    weekId = selectedWeek,
    versions = baseVersions
  ) {
    if (!weekId) return {};

    setLoadedBaseForWeek("");
    const rotaData = await getBaseRotaForWeek(weekId, versions);
    setRota(rotaData);
    setLoadedBaseForWeek(weekId);
    return rotaData;
  }

  useEffect(() => {
    const individualProfileReady = isLegacyAdmin || isLegacyViewer || Boolean(userProfile);

    if (user && !individualProfileReady) {
      return;
    }

    if (!user) {
      setWeeks([]);
      setSelectedWeek("");
      setRota({});
      setBaseVersions([]);
      setBaseEditorRota({});
      setBaseEditorWeek2Rota({});
      setBasePatternLength(1);
      setBaseTemplateWeek(1);
      setBaseEffectiveFrom("");
      setEditingBaseVersionId("");
      setLoadedBaseForWeek("");
      setOverrides({});
      setLoadedOverridesForWeek("");
      setEditDayNoteIndex(null);
      setEditDayNote("");
      setAnnualLeave([]);
      setAnnualLeaveArchive([]);
      setEmployees([]);
      clearEmployeeForm();
      setPayrollWeek("");
      setPayrollPreview([]);
      setPayrollUnmatchedNames([]);
      setPayrollAdjustments([]);
      clearPayrollAdjustmentForm();
      setPayrollMode("weekly");
      setPayrollStartDate("");
      setPayrollEndDate("");
      setPayrollPeriodLabel("");
      setAnnualLeaveSidebarOpen(false);
      setAnnualLeaveLoading(false);
      setArchiveWeeks([]);
      setSelectedArchiveWeek("");
      setArchiveLoading(false);
      maintenanceStartedRef.current = false;
      loadingGenerationRef.current += 1;
      secondaryRequestsRef.current = {};
      setLoadErrors({});
      setLoadStatus({});
      setDataLoading(false);
      return;
    }

    let cancelled = false;

    async function loadInitialRotaData() {
      if (!cancelled) {
        setDataLoading(true);
        setLoadErrors((old) => ({ ...old, weeks: "" }));
        setLoadStatus((old) => ({ ...old, weeks: "loading" }));
        setOverrides({});
        setLoadedOverridesForWeek("");
      }

      try {
        // Always load existing weeks first so the rota remains usable.
        let loadedWeeks = await loadSection("weeks", () => loadWeeks());

        if (isAdmin) {
          try {
            const createdMissingWeeks = await ensureEightWeeks(loadedWeeks);

            if (createdMissingWeeks) {
              loadedWeeks = await loadWeeks();
            }
          } catch (err) {
            console.error("Failed to ensure future weeks:", err);
          }
        }

        // Base rota is essential; optional sections are independent and never
        // hold the weekly rota behind their own network requests.
        const loadedVersions = await loadSection("base", () => loadBaseVersions());
        const optional = [
          ["employees", () => loadEmployees()],
          ["annualLeave", () => loadAnnualLeave()],
        ];
        if (isAdmin) optional.push(
          ["annualLeaveArchive", () => loadAnnualLeaveArchive()],
          ["payrollAdjustments", () => loadPayrollAdjustments()],
          ["sickness", () => loadSicknessAbsences()],
        );
        optional.forEach(([key, loader]) => {
          loadSection(key, loader).catch((error) => console.error(`Optional section ${key} unavailable`, error));
        });

        // Maintenance is independent of the first render, but still runs only
        // once per session. A maintenance failure must not block the rota.
        if (isAdmin && !maintenanceStartedRef.current) {
          maintenanceStartedRef.current = true;
          (async () => {
            try {
              const result = await runRotaMaintenance(loadedWeeks, loadedVersions);
              console.info("Rota maintenance complete:", result);
              await loadWeeks();
              await loadSection("base", () => loadBaseVersions());
            } catch (err) {
              console.error("Rota maintenance failed safely:", err);
              maintenanceStartedRef.current = false;
            }
            loadSection("archive", () => loadArchiveWeeks()).catch((error) => console.error("Archive unavailable", error));
          })();
        }
      } catch (error) {
        console.error("Failed to load initial rota data:", error);
        if (!cancelled) {
          setLoadErrors((old) => ({ ...old, weeks: error?.message || "The rota could not be loaded." }));
          setLoadStatus((old) => ({ ...old, weeks: "error" }));
        }
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
  }, [user, userProfile, isEditor, isAdmin, loadAttempt]);

  useEffect(() => {
    if (initialRotaReady || !user) { setInitialLoadSlow(false); return; }
    const timer = setTimeout(() => setInitialLoadSlow(true), 12000);
    return () => clearTimeout(timer);
  }, [user, initialRotaReady, loadAttempt]);

  useEffect(() => {
    if (!user || weeks.length === 0) return;

    const availableWeeks = weeks.filter((week) => {
      const weekId = normaliseWeekId(week);
      if (!weekId || (weekId > newestLiveWeekId && week.status !== "published-early")) return false;

      return isEditor
        ? weekId >= oldestLiveWeekId
        : weekId >= currentWeekId;
    });

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
  }, [
    user,
    weeks,
    isEditor,
    selectedWeek,
    currentWeekId,
    oldestLiveWeekId,
    newestLiveWeekId,
  ]);

  function clearLogoutTimers() {
    clearTimeout(warningTimer.current);
    clearTimeout(logoutTimer.current);
    clearInterval(countdownInterval.current);
  }

  async function performAutoLogout() {
    clearLogoutTimers();
    warningActive.current = false;
    setShowLogoutWarning(false);
    await signOut(auth);
  }

  function resetLogoutTimers() {
    clearLogoutTimers();

    lastActivityTime.current = Date.now();
    warningActive.current = false;
    setShowLogoutWarning(false);
    setCountdown(WARNING_DURATION / 1000);

    warningTimer.current = setTimeout(() => {
      warningActive.current = true;
      setShowLogoutWarning(true);

      let remaining = WARNING_DURATION / 1000;
      setCountdown(remaining);

      countdownInterval.current = setInterval(() => {
        remaining -= 1;
        setCountdown(remaining);

        if (remaining <= 0) {
          clearInterval(countdownInterval.current);
        }
      }, 1000);

      logoutTimer.current = setTimeout(() => {
        performAutoLogout();
      }, WARNING_DURATION);
    }, INACTIVITY_TIMEOUT - WARNING_DURATION);
  }

  function handleUserActivity() {
    if (warningActive.current) return;
    resetLogoutTimers();
  }

  function continueSession() {
    resetLogoutTimers();
  }

  async function logoutNow() {
    await performAutoLogout();
  }

  function checkInactiveTimeOnResume() {
    if (!user) return;

    const inactiveFor = Date.now() - lastActivityTime.current;

    if (inactiveFor >= INACTIVITY_TIMEOUT) {
      performAutoLogout();
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") {
      checkInactiveTimeOnResume();
    }
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

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", checkInactiveTimeOnResume);

    resetLogoutTimers();

    return () => {
      clearLogoutTimers();

      events.forEach((event) => {
        window.removeEventListener(event, handleUserActivity);
      });

      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", checkInactiveTimeOnResume);
    };
  }, [user]);


  useEffect(() => {
    if (!user || !selectedWeek) {
      setRota({});
      setLoadedBaseForWeek("");
      return;
    }

    loadBaseRotaForSelectedWeek().catch((error) => {
      console.error("Failed to load dated base rota:", error);
      setRota({});
      setLoadedBaseForWeek(selectedWeek);
    });
  }, [user, selectedWeek, baseVersions]);

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

  useEffect(() => {
    if (!user || !selectedWeek) {
      setEditDayNote("");
      return;
    }

    if (!editDayNoteIndex) {
      setEditDayNote("");
      return;
    }

    const notes = getSelectedWeekDayNotes();
    setEditDayNote(
      notes?.[editDayNoteIndex] || notes?.[String(editDayNoteIndex)] || ""
    );
  }, [user, selectedWeek, weeks, editDayNoteIndex]);

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
    setEditVacantSlots(override?.vacantSlots ?? rota?.[dayIndex]?.[shift]?.vacantSlots ?? 0);
    setEditNote(override?.note ?? "");
  }

  function loadSelectedCellIntoEditor() {
    loadCellIntoEditor(editDayIndex, editShift);
  }

  function loadBaseCellIntoEditor(dayIndex, shift) {
    if (!isEditor) return;

    const activeBaseEditorRota =
      baseTemplateWeek === 2 ? baseEditorWeek2Rota : baseEditorRota;
    const baseStaff = activeBaseEditorRota?.[dayIndex]?.[shift]?.staff || [];

    setBaseDayIndex(dayIndex);
    setBaseShift(shift);
    setBaseStaffText(baseStaff.join("\n"));
    setBaseVacantSlots(Math.max(0, Number(activeBaseEditorRota?.[dayIndex]?.[shift]?.vacantSlots) || 0));
  }

  function loadSelectedBaseCellIntoEditor() {
    loadBaseCellIntoEditor(baseDayIndex, baseShift);
  }

  async function loadBaseEditorForWeek(effectiveFrom) {
    if (!effectiveFrom || !isEditor) return;

    setBaseEditorLoading(true);
    setBaseEffectiveFrom(effectiveFrom);

    try {
      const exactVersion = baseVersions.find(
        (version) => version.effectiveFrom === effectiveFrom
      );

      if (exactVersion) {
        const patternLength = getVersionPatternLength(exactVersion);
        setEditingBaseVersionId(exactVersion.id);
        setBasePatternLength(patternLength);
        setBaseTemplateWeek(1);
        setBaseEditorRota(await loadVersionRota(exactVersion.id, 1));
        setBaseEditorWeek2Rota(
          patternLength === 2
            ? await loadVersionRota(exactVersion.id, 2)
            : {}
        );
      } else {
        setEditingBaseVersionId("");
        setBasePatternLength(1);
        setBaseTemplateWeek(1);
        const inheritedRota = await getBaseRotaForWeek(effectiveFrom);
        setBaseEditorRota(inheritedRota);
        setBaseEditorWeek2Rota(inheritedRota);
      }
    } finally {
      setBaseEditorLoading(false);
    }
  }

  useEffect(() => {
    if (!isEditor || adminView !== "base" || weeks.length === 0) return;

    const lastGeneratedWeek = [...weeks].map(normaliseWeekId).filter(Boolean).sort().at(-1);
    const firstAvailableWeek = lastGeneratedWeek
      ? toDateId(addDays(lastGeneratedWeek, 7)) : currentWeekId;

    if (!baseEffectiveFrom && firstAvailableWeek) {
      loadBaseEditorForWeek(firstAvailableWeek);
    }
  }, [isEditor, adminView, weeks, baseVersions, baseEffectiveFrom, currentWeekId]);

  async function ensureBaseVersionExists() {
    if (editingBaseVersionId) return editingBaseVersionId;
    if (!baseEffectiveFrom) throw new Error("Choose an effective week first.");

    const versionId = baseEffectiveFrom;
    const sourceRota = baseEditorRota;

    await setDoc(doc(db, "baseTemplateVersions", versionId), {
      effectiveFrom: baseEffectiveFrom,
      patternLength: basePatternLength,
      status: baseEffectiveFrom > currentWeekId ? "pending" : "active",
      createdAt: new Date().toISOString(),
      createdBy: user?.email || "unknown",
      updatedAt: new Date().toISOString(),
      updatedBy: user?.email || "unknown",
    });

    const writes = [];
    DAYS.forEach((day) => {
      SHIFTS.forEach((shift) => {
        const shiftId = makeOverrideId(day.dayIndex, shift);
        const week1Staff = sourceRota?.[day.dayIndex]?.[shift]?.staff || [];
        const week1Vacancies = Math.max(0, Number(sourceRota?.[day.dayIndex]?.[shift]?.vacantSlots) || 0);
        writes.push(
          setDoc(
            doc(db, "baseTemplateVersions", versionId, "shifts", shiftId),
            {
              dayIndex: day.dayIndex,
              shift,
              staff: week1Staff,
              vacantSlots: week1Vacancies,
              updatedAt: new Date().toISOString(),
              updatedBy: user?.email || "unknown",
            }
          )
        );

        if (basePatternLength === 2) {
          const week2Staff =
            baseEditorWeek2Rota?.[day.dayIndex]?.[shift]?.staff || [];
          writes.push(
            setDoc(
              doc(db, "baseTemplateVersions", versionId, "week2Shifts", shiftId),
              {
                dayIndex: day.dayIndex,
                shift,
                staff: week2Staff,
                vacantSlots: Math.max(0, Number(baseEditorWeek2Rota?.[day.dayIndex]?.[shift]?.vacantSlots) || 0),
                updatedAt: new Date().toISOString(),
                updatedBy: user?.email || "unknown",
              }
            )
          );
        }
      });
    });

    await Promise.all(writes);
    setEditingBaseVersionId(versionId);
    await loadBaseVersions();
    return versionId;
  }

  async function saveBaseShift() {
    if (!isEditor || !baseEffectiveFrom) return;

    const staff = canonicaliseRegisteredStaffNames(
      baseStaffText
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean)
    );

    const versionId = await ensureBaseVersionExists();
    const baseShiftId = makeOverrideId(baseDayIndex, baseShift);
    const shiftCollection = baseTemplateWeek === 2 ? "week2Shifts" : "shifts";

    await auditedWrite(
      doc(db, "baseTemplateVersions", versionId, shiftCollection, baseShiftId),
      {
        dayIndex: Number(baseDayIndex),
        shift: baseShift,
        staff,
        vacantSlots: Math.max(0, Number(baseVacantSlots) || 0),
        updatedAt: new Date().toISOString(),
        updatedBy: user?.email || "unknown",
      }
    );

    await setDoc(
      doc(db, "baseTemplateVersions", versionId),
      {
        effectiveFrom: baseEffectiveFrom,
        patternLength: basePatternLength,
        status: baseEffectiveFrom > currentWeekId ? "pending" : "active",
        updatedAt: new Date().toISOString(),
        updatedBy: user?.email || "unknown",
      },
      { merge: true }
    );

    const updateEditorRota = (setter) =>
      setter((currentRota) => ({
        ...currentRota,
        [baseDayIndex]: {
          ...(currentRota?.[baseDayIndex] || {}),
          [baseShift]: { staff, vacantSlots: Math.max(0, Number(baseVacantSlots) || 0), id: baseShiftId },
        },
      }));

    if (baseTemplateWeek === 2) updateEditorRota(setBaseEditorWeek2Rota);
    else updateEditorRota(setBaseEditorRota);

    await loadBaseVersions();
    if (selectedWeek) await loadBaseRotaForSelectedWeek(selectedWeek);
  }

  async function clearBaseShift() {
    if (!isEditor || !baseEffectiveFrom) return;

    const versionId = await ensureBaseVersionExists();
    const baseShiftId = makeOverrideId(baseDayIndex, baseShift);
    const shiftCollection = baseTemplateWeek === 2 ? "week2Shifts" : "shifts";

    await auditedWrite(
      doc(db, "baseTemplateVersions", versionId, shiftCollection, baseShiftId),
      {
        dayIndex: Number(baseDayIndex),
        shift: baseShift,
        staff: [],
        vacantSlots: 0,
        updatedAt: new Date().toISOString(),
        updatedBy: user?.email || "unknown",
      }
    );

    setBaseStaffText("");
    setBaseVacantSlots(0);
    const clearEditorRota = (setter) =>
      setter((currentRota) => ({
        ...currentRota,
        [baseDayIndex]: {
          ...(currentRota?.[baseDayIndex] || {}),
          [baseShift]: { staff: [], vacantSlots: 0, id: baseShiftId },
        },
      }));

    if (baseTemplateWeek === 2) clearEditorRota(setBaseEditorWeek2Rota);
    else clearEditorRota(setBaseEditorRota);

    await loadBaseVersions();
    if (selectedWeek) await loadBaseRotaForSelectedWeek(selectedWeek);
  }

  async function cancelBaseVersion(versionId) {
    if (!isEditor) return;

    const shiftsSnapshot = await getDocs(
      collection(db, "baseTemplateVersions", versionId, "shifts")
    );
    const week2Snapshot = await getDocs(
      collection(db, "baseTemplateVersions", versionId, "week2Shifts")
    );

    await Promise.all([
      ...shiftsSnapshot.docs.map((shiftDoc) => deleteDoc(shiftDoc.ref)),
      ...week2Snapshot.docs.map((shiftDoc) => deleteDoc(shiftDoc.ref)),
    ]);

    await deleteDoc(doc(db, "baseTemplateVersions", versionId));
    const refreshedVersions = await loadBaseVersions();

    if (editingBaseVersionId === versionId) {
      setEditingBaseVersionId("");
      setBaseEditorRota(
        await getBaseRotaForWeek(baseEffectiveFrom, refreshedVersions)
      );
    }

    if (selectedWeek) {
      await loadBaseRotaForSelectedWeek(selectedWeek, refreshedVersions);
    }
  }

  async function saveOverride() {
    if (!selectedWeek || !isEditor) return;

    const staff = canonicaliseRegisteredStaffNames(
      editStaffText
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean)
    );

    const overrideId = makeOverrideId(editDayIndex, editShift);

    await auditedWrite(doc(db, "rotaWeeks", selectedWeek, "overrides", overrideId), {
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

    await auditedWrite(doc(db, "rotaWeeks", selectedWeek, "overrides", overrideId), null, { delete: true });

    setEditStaffText("");
    setEditVacantSlots(0);
    setEditNote("");

    await loadOverrides();
  }

  function getSelectedWeekDayNotes() {
    const week = weeks.find((item) => normaliseWeekId(item) === selectedWeek);
    return week?.dayNotes || {};
  }

  function loadDayNoteIntoEditor(dayIndex) {
    if (!isEditor) return;

    const notes = getSelectedWeekDayNotes();
    setEditDayNoteIndex(Number(dayIndex));
    setEditDayNote(notes?.[dayIndex] || notes?.[String(dayIndex)] || "");
  }

  async function saveDayNote() {
    if (!selectedWeek || !isEditor || !editDayNoteIndex) return;

    const week = weeks.find((item) => normaliseWeekId(item) === selectedWeek);
    const currentNotes = week?.dayNotes || {};
    const nextNotes = {
      ...currentNotes,
      [String(editDayNoteIndex)]: editDayNote.trim(),
    };

    await setDoc(
      doc(db, "rotaWeeks", selectedWeek),
      {
        dayNotes: nextNotes,
        updatedAt: new Date().toISOString(),
        updatedBy: user?.email || "unknown",
      },
      { merge: true }
    );

    await loadWeeks();
  }

  async function clearDayNote() {
    if (!selectedWeek || !isEditor || !editDayNoteIndex) return;

    const week = weeks.find((item) => normaliseWeekId(item) === selectedWeek);
    const nextNotes = { ...(week?.dayNotes || {}) };
    delete nextNotes[String(editDayNoteIndex)];

    await setDoc(
      doc(db, "rotaWeeks", selectedWeek),
      {
        dayNotes: nextNotes,
        updatedAt: new Date().toISOString(),
        updatedBy: user?.email || "unknown",
      },
      { merge: true }
    );

    setEditDayNote("");
    await loadWeeks();
  }

  const todayId = toDateId(new Date());

  const upcomingAnnualLeave = annualLeave.filter(
    (leave) => leave.endDate >= todayId
  );
  const pastAnnualLeave = annualLeave
    .filter((leave) => leave.endDate < todayId)
    .sort((a, b) => b.endDate.localeCompare(a.endDate));
  const displayedAnnualLeave = showPastAnnualLeave
    ? [...upcomingAnnualLeave, ...pastAnnualLeave]
    : upcomingAnnualLeave;

  const selectedWeekAnnualLeave = selectedWeek
    ? annualLeave.filter((leave) => annualLeaveOverlapsWeek(leave, selectedWeek))
    : [];

  const selectedArchive =
    archiveWeeks.find(
      (week) => week.weekStart === selectedArchiveWeek
    ) || null;

  const payrollWeekOptions = [
    ...archiveWeeks.map((week) => ({
      weekStart: week.weekStart,
      source: "archive",
    })),
    ...weeks.map((week) => ({
      weekStart: normaliseWeekId(week),
      source: "live",
    })),
  ]
    .filter((week) => week.weekStart)
    .filter(
      (week, index, array) =>
        array.findIndex((item) => item.weekStart === week.weekStart) === index
    )
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));


  const archiveDayLabels = selectedArchive
    ? selectedArchive.days.map((day) => ({
        dayIndex: day.dayIndex,
        label: formatDayLabel(parseLocalDate(day.date)),
      }))
    : [];

  const dayLabels = selectedWeek
    ? Array.from({ length: 7 }, (_, index) => ({
        dayIndex: index + 1,
        label: formatDayLabel(addDays(selectedWeek, index)),
      }))
    : [];

  useEffect(() => {
    if (!isEditor || !["archive", "payroll"].includes(adminView) || loadStatus.archive === "ready" || loadStatus.archive === "loading" || loadStatus.archive === "error") return;
    loadSection("archive", () => loadArchiveWeeks()).catch((error) => console.error("Archive load failed", error));
  }, [adminView, isEditor, loadStatus.archive]);

  useEffect(() => {
    if (!isAdmin || adminView !== "payroll") return;

    if (
      payrollWeek &&
      payrollWeekOptions.some((week) => week.weekStart === payrollWeek)
    ) {
      return;
    }

    const preferredWeek =
      payrollWeekOptions.find((week) => week.weekStart === currentWeekId) ||
      payrollWeekOptions[0];

    if (preferredWeek) {
      setPayrollWeek(preferredWeek.weekStart);
      setPayrollPreview([]);
      setPayrollUnmatchedNames([]);
    }
  }, [isAdmin, adminView, payrollWeek, weeks, archiveWeeks, currentWeekId]);

  const weeklyRotaReady =
    !dataLoading &&
    Boolean(selectedWeek) &&
    loadedBaseForWeek === selectedWeek &&
    !overridesLoading &&
    loadedOverridesForWeek === selectedWeek;

  useEffect(() => {
    if (user && weeklyRotaReady && !initialRotaReady) {
      setInitialRotaReady(true);
    }
  }, [user, weeklyRotaReady, initialRotaReady]);

  useEffect(() => {
    if (!hasPersonalUpcomingShifts || !linkedEmployeeId || staffDirectory.length === 0) return;
    if (!staffDirectory.some((employee) => employee.id === linkedEmployeeId)) return;

    if (viewerEmployeeId !== linkedEmployeeId) {
      setViewerEmployeeId(linkedEmployeeId);
    }
    loadViewerUpcomingShifts(linkedEmployeeId);
  }, [hasPersonalUpcomingShifts, linkedEmployeeId, staffDirectory]);

  const payrollPeriodHasSickness = payrollPreview.some((row) => Number(row.sicknessHours || 0) > 0);
  const payrollPeriodHasAdjustments = payrollPreview.some(
    (row) => Number(row.adjustmentHours || 0) !== 0
  );

  if (authLoading || userProfileLoading) {
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
                placeholder="Username"
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

  if (userProfile?.accountEnabled === false) {
    return (
      <main className="page"><section className="login-panel">
        <img src={lcMonogram} alt="LC Monogram" className="lc-monogram login-monogram" />
        <h2>Account Disabled</h2>
        <p className="account-gate-message">This login account is currently disabled. Please contact an administrator.</p>
        <button type="button" onClick={logout}>Sign Out</button>
      </section></main>
    );
  }

  if (userProfile?.mustChangePassword) {
    return (
      <main className="page"><section className="login-panel password-change-panel">
        <img src={lcMonogram} alt="LC Monogram" className="lc-monogram login-monogram" />
        <h2>Choose a New Password</h2>
        <p className="account-gate-message">Your temporary password has been accepted. Choose your own password before continuing.</p>
        <form onSubmit={handleForcedPasswordChange}>
          <label>New Password<input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength="8" autoComplete="new-password" required /></label>
          <label>Confirm New Password<input type="password" value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} minLength="8" autoComplete="new-password" required /></label>
          <button type="submit" disabled={passwordChangeLoading}>{passwordChangeLoading ? "Saving..." : "Set New Password"}</button>
        </form>
        <button type="button" className="account-signout-link" onClick={logout}>Sign Out</button>
      </section></main>
    );
  }

  if (user && !initialRotaReady) {
    return <main className="page"><section className="rota-load-panel">
      <img src={lcMonogram} alt="Longcroft" className="lc-monogram login-monogram" />
      <h2>{loadStatus.weeks === "error" ? "Unable to load rota" : initialLoadSlow ? "The rota is taking longer than expected" : "Loading rota…"}</h2>
      {(loadStatus.weeks === "error" || initialLoadSlow) && <>
        <p>Check your connection and try again. No rota changes have been made.</p>
        <button type="button" onClick={() => setLoadAttempt((value) => value + 1)}>Retry loading</button>
      </>}
      {loadStatus.weeks === "error" && <p className="rota-load-detail">{loadErrors.weeks}</p>}
      <button type="button" className="loading-signout-btn" onClick={logout}>Sign Out</button>
    </section></main>;
  }

  return (
    <main className="page">
      <section className="rota-paper">
        <header className="rota-header">
          <div className="auth-bar">
            <span>
              Logged in as:{" "}
              <strong>
                {isLegacyAdmin
                  ? "admin"
                  : isLegacyViewer
                    ? "user"
                    : userProfile?.displayName || userProfile?.username || accountRole}
              </strong>
            </span>
          <div className="auth-actions">
            {!isIndividualStaff && (adminView === "weekly" || adminView === "base" || adminView === "payroll") && (
              <button
                type="button"
                className="annual-leave-sidebar-toggle"
                onClick={() => setAnnualLeaveSidebarOpen(true)}
              >
                Annual Leave
                {upcomingAnnualLeave.length > 0 && (
                  <span className="annual-leave-count">
                    {upcomingAnnualLeave.length}
                  </span>
                )}
              </button>
            )}

            {(adminView === "weekly" || adminView === "base" || adminView === "payroll") && (
              <button
                type="button"
                className="upcoming-shifts-sidebar-toggle"
                onClick={() => {
                  setUpcomingShiftsSidebarOpen(true);
                  if (hasPersonalUpcomingShifts && linkedEmployeeId) {
                    loadViewerUpcomingShifts(linkedEmployeeId);
                  }
                }}
              >
                <span className="upcoming-shifts-label-desktop">Upcoming Shifts</span>
                <span className="upcoming-shifts-label-mobile">Shifts</span>
              </button>
            )}

            {isAdmin && adminView !== "payroll" && (
              <button
                type="button"
                className="payroll-button"
                onClick={() => setAdminView("payroll")}
              >
                Staff
              </button>
            )}

            {adminView !== "payroll" && (
              <button
                type="button"
                onClick={handlePrint}
                className="print-button"
              >
                Print Rota
              </button>
            )}

            <button type="button" onClick={logout}>
              Logout
            </button>
          </div>
        </div>
          {isAdmin && auditOpen && <div className="audit-backdrop" onClick={() => setAuditOpen(false)}>
            <section className="audit-dialog" role="dialog" aria-modal="true" aria-label="Audit log"
              onClick={event => event.stopPropagation()}>
              <header className="audit-header"><h2>Audit Log</h2>
                <button type="button" onClick={() => setAuditOpen(false)}>Close</button></header>
              <p>Changes made by senior and admin accounts appear here when recorded. Export contains currently loaded entries, not the entire history.</p>
              <div className="audit-actions">
                <button type="button" disabled={auditBusy} onClick={() => loadAuditEntries(true)}>Refresh</button>
                <button type="button" disabled={!auditEntries.length} onClick={exportAuditJson}>Export loaded JSON</button>
              </div>
              {auditError && <p className="audit-error">{auditError}</p>}
              <div className="audit-list">{auditEntries.map(entry =>
                <article className="audit-item" key={entry.id}>
                  <strong>{entry.action} — {entry.targetPath}</strong>
                  <small>{entry.createdAt?.toDate?.()?.toLocaleString("en-GB") || "Pending"} · {entry.actorEmail || entry.actorUid || "Unknown"}</small>
                  <details><summary>Before / after</summary>
                    <pre>{JSON.stringify({before:entry.before,after:entry.after},null,2)}</pre>
                  </details>
                </article>)}
                {!auditEntries.length && !auditBusy && <p>No audit entries found.</p>}
              </div>
              {auditCursor && <button type="button" disabled={auditBusy} onClick={() => loadAuditEntries(false)}>
                {auditBusy ? "Loading…" : "Load 40 more"}
              </button>}
            </section></div>}
          <img
            src={lcMonogram}
            alt="LC Monogram"
            className="lc-monogram rota-monogram"
          />
          {/* <h1>LONGCROFT</h1> */}
          {/* <h2>Residential Care Home</h2> */}
          <h3>Staff Rota</h3>

          {adminView === "weekly" && selectedWeek && (
            <p>W/C {formatWeekCommencing(selectedWeek)}</p>
          )}

          {isEditor && adminView === "archive" && selectedArchiveWeek && (
            <p>Archived W/C {formatWeekCommencing(selectedArchiveWeek)}</p>
          )}

          {isEditor && adminView !== "payroll" && (
            <div className="admin-tabs">
              <button type="button" className={`scheduled-icon-button ${adminView === "scheduled" ? "active-tab" : ""}`}
                title="Generate a specific week" aria-label="Generate a specific week"
                onClick={() => setAdminView("scheduled")}>＋</button>
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

              <button
                type="button"
                className={adminView === "archive" ? "active-tab" : ""}
                onClick={() => {
                  setAdminView("archive");

                  // Archive data is normally loaded during admin start-up.
                  // Only request it here when there is no data and no existing
                  // request is already running.
                  if (archiveWeeks.length === 0 && !archiveLoading) {
                    loadArchiveWeeks().catch(() => {});
                  }
                }}
              >
                Rota Archive
              </button>
            </div>
          )}

          {isEditor && adminView === "archive" && (
            <select
              value={selectedArchiveWeek}
              onChange={(e) => setSelectedArchiveWeek(e.target.value)}
              className="week-select"
              disabled={archiveWeeks.length === 0}
            >
              {archiveWeeks.length === 0 ? (
                <option value="">No archived rotas</option>
              ) : (
                archiveWeeks.map((week) => (
                  <option key={week.id} value={week.weekStart}>
                    W/C {formatWeekCommencing(week.weekStart)}
                  </option>
                ))
              )}
            </select>
          )}

          {adminView === "weekly" && (
            <>
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
                  <option
                    key={week.id}
                    value={week.weekStart}
                    style={{
                      fontWeight:
                        week.weekStart === currentWeekId ? "700" : "400",
                    }}
                  >
                    W/C {formatWeekCommencing(week.weekStart)}
                  </option>
                ))}
              </select>
              {isAdmin && selectedWeek > newestLiveWeekId && weeks.some((week) => week.weekStart === selectedWeek && week.status === "published-early") && (
                <button type="button" className="delete-scheduled-week-button"
                  disabled={deletingScheduledWeek} onClick={deleteEarlyPublishedWeek}>
                  {deletingScheduledWeek ? "Deleting…" : "Delete Scheduled Week"}
                </button>
              )}
            </>
          )}

        </header>
        {isEditor && adminView === "scheduled" && (
          <section className="editor-panel scheduled-week-panel">
            <h2>Generate Specific Week</h2>
            <p>Prepare an exceptional week ahead of the rolling rota. Choose its Monday, edit the frozen shift snapshot, then save privately or publish early.</p>
            <div className="scheduled-week-picker">
              <div className="scheduled-date-control">
                <label id="scheduled-week-date-label">Week commencing (Monday)</label>
                <button type="button" className="scheduled-date-trigger"
                  aria-labelledby="scheduled-week-date-label" aria-expanded={scheduledCalendarOpen}
                  aria-haspopup="dialog"
                  onClick={() => setScheduledCalendarOpen((open) => !open)}>
                  <span>{scheduledWeek ? formatWeekCommencing(scheduledWeek) : "Choose Monday"}</span>
                  <span aria-hidden="true">▾</span>
                </button>
                {scheduledCalendarOpen && (
                  <div className="scheduled-calendar-popover" role="dialog" aria-label="Choose week commencing Monday">
                    <DayPicker
                      mode="single"
                      weekStartsOn={1}
                      showOutsideDays
                      selected={scheduledWeek ? parseLocalDate(scheduledWeek) : undefined}
                      defaultMonth={scheduledWeek ? parseLocalDate(scheduledWeek) : getCurrentMondayDate()}
                      disabled={[{ dayOfWeek: [0, 2, 3, 4, 5, 6] }, { before: getCurrentMondayDate() }]}
                      onSelect={(date) => {
                        if (!date || date.getDay() !== 1) return;
                        const monday = toDateId(date);
                        if (monday < currentWeekId) return;
                        setScheduledWeek(monday);
                        setScheduledDraft(null);
                        setScheduledDayNoteIndex(null);
                        setScheduledDayNoteText("");
                        setScheduledCalendarOpen(false);
                      }}
                    />
                  </div>
                )}
              </div>
              <button type="button" className="scheduled-open-button" disabled={!scheduledWeek || scheduledLoading}
                onClick={() => openScheduledWeek(scheduledWeek)}>
                {scheduledLoading ? "Loading…" : "Open / Create Week"}
              </button>
            </div>
            {scheduledDraft && scheduledDraft.weekStart === scheduledWeek && (
              <>
                <p><strong>W/C {formatWeekCommencing(scheduledWeek)}</strong> — {scheduledDraft.status === "published" ? "Published" : "Unpublished draft"}</p>
                {scheduledDraft.status === "published" && <p>This week is already published. Make further changes in the Weekly Rota Editor.</p>}
                <div className="scheduled-week-scroll">
                  <table className="rota-table scheduled-preview-table">
                    <thead><tr><th>Shift</th>{DAYS.map(({ dayIndex, name }) => {
                      const note = scheduledDraft.dayNotes?.[dayIndex] || scheduledDraft.dayNotes?.[String(dayIndex)] || "";
                      const selected = scheduledDayNoteIndex === dayIndex;
                      return <th key={dayIndex} className={`${scheduledDraft.status !== "published" ? "clickable-day-heading" : ""} ${selected ? "selected-day-heading" : ""}`}
                        title={scheduledDraft.status !== "published" ? "Click to edit this day's note" : ""}
                        onClick={() => loadScheduledDayNote(dayIndex)}>
                        {name}<small>{formatDayLabel(addDays(scheduledWeek, dayIndex - 1))}</small>
                        {note && <div className="day-note">{note}</div>}
                      </th>;
                    })}</tr></thead>
                    <tbody>{SHIFTS.map((shift) => <tr key={shift}>
                      <th>{shift}</th>
                      {DAYS.map(({ dayIndex, name }) => {
                        const cell = scheduledDraft.shifts?.[dayIndex]?.[shift] || {};
                        const selected = scheduledDay === dayIndex && scheduledShift === shift;
                        return <td key={dayIndex}>
                          <button type="button" className={`scheduled-preview-cell ${selected ? "scheduled-preview-selected" : ""}`}
                            onClick={() => { setScheduledDay(dayIndex); setScheduledShift(shift); }}
                            aria-pressed={selected} aria-label={`Select ${name}, ${shift}`}>
                            {(cell.staff || []).filter(Boolean).length ? (cell.staff || []).filter(Boolean).map((person, index) => <span key={index}>{person}</span>) : <span className="empty-cell">—</span>}
                            {Number(cell.vacantSlots) > 0 && <span className="vacant">VACANT x{cell.vacantSlots}</span>}
                            {cell.note && <span className="note">{cell.note}</span>}
                          </button>
                        </td>;
                      })}
                    </tr>)}</tbody>
                  </table>
                </div>
                {scheduledDraft.status !== "published" && (
                  <section className="scheduled-shift-editor editor-panel">
                    <h3>Scheduled Shift Editor</h3>
                    <div className="editor-grid">
                      <label>Day
                        <select value={scheduledDay} onChange={(e) => setScheduledDay(Number(e.target.value))}>
                          {DAYS.map((day) => <option key={day.dayIndex} value={day.dayIndex}>{day.name}</option>)}
                        </select>
                      </label>
                      <label>Shift
                        <select value={scheduledShift} onChange={(e) => setScheduledShift(e.target.value)}>
                          {SHIFTS.map((shift) => <option key={shift} value={shift}>{shift}</option>)}
                        </select>
                      </label>
                      <label>Vacant Slots
                        <input type="number" min="0" max="20"
                          value={scheduledDraft.shifts?.[scheduledDay]?.[scheduledShift]?.vacantSlots ?? 0}
                          onChange={(e) => updateScheduledCell(scheduledDay, scheduledShift, { vacantSlots: Math.max(0, Number(e.target.value) || 0) })} />
                      </label>
                    </div>
                    <RotaStaffPicker
                      employees={isAdmin ? employees : staffDirectory}
                      value={scheduledDraft.shifts?.[scheduledDay]?.[scheduledShift]?.staff || []}
                      onChange={(staff) => updateScheduledCell(scheduledDay, scheduledShift, { staff })}
                    />
                    <label className="editor-full">Shift Note
                      <input value={scheduledDraft.shifts?.[scheduledDay]?.[scheduledShift]?.note || ""}
                        onChange={(e) => updateScheduledCell(scheduledDay, scheduledShift, { note: e.target.value })} />
                    </label>
                  </section>
                )}
                {scheduledDraft.status !== "published" && (
                  <section className="editor-panel day-note-editor scheduled-day-note-editor">
                    <h2>Day Note</h2>
                    <p className="note">Add a short note for the whole day. Click a day heading above to select it.</p>
                    <div className="day-note-editor-grid">
                      <label>Day
                        <select value={scheduledDayNoteIndex ?? ""} onChange={(e) => {
                          if (!e.target.value) { setScheduledDayNoteIndex(null); setScheduledDayNoteText(""); }
                          else loadScheduledDayNote(Number(e.target.value));
                        }}>
                          <option value="">Select a day</option>
                          {DAYS.map((day) => <option key={day.dayIndex} value={day.dayIndex}>{day.name}</option>)}
                        </select>
                      </label>
                      <label className="day-note-input-label">Day Note
                        <input value={scheduledDayNoteText} onChange={(e) => setScheduledDayNoteText(e.target.value)}
                          placeholder="e.g. Staff Meeting / New Meds" />
                      </label>
                    </div>
                    <div className="editor-actions">
                      <button type="button" onClick={saveScheduledDayNote} disabled={!scheduledDayNoteIndex}>Save Day Note</button>
                      <button type="button" className="danger" onClick={clearScheduledDayNote} disabled={!scheduledDayNoteIndex}>Clear Day Note</button>
                    </div>
                    <p className="note">Day note changes are included when you save the scheduled draft or publish the week.</p>
                  </section>
                )}
                <label className="scheduled-publish-choice">
                  <input type="checkbox" disabled={scheduledDraft.status === "published"} checked={scheduledDraft.publishEarly || false}
                    onChange={(e) => setScheduledDraft((old) => ({ ...old, publishEarly: e.target.checked }))} />
                  Publish immediately
                </label>
                <button type="button" className="scheduled-save-button" disabled={scheduledPublishing || scheduledDraft.status === "published"}
                  onClick={() => saveScheduledDraft(Boolean(scheduledDraft.publishEarly))}>
                  {scheduledPublishing ? "Saving…" : scheduledDraft.publishEarly ? "Save and Publish Week" : "Save Draft Week"}
                </button>
              </>
            )}
          </section>
        )}
        {adminView === "weekly" && (
          <>
            {isEditor && <SectionNotice section="employees" title="Employee register" />}
            <SectionNotice section="annualLeave" title="Annual leave" />
            {!weeklyRotaReady ? (
              <p className="loading-text">Loading rota...</p>
            ) : (
              <>
        {selectedWeekAnnualLeave.length > 0 && (
          <section className="annual-leave-warning" aria-label="Annual leave reminder">
            <strong>Annual Leave Reminder</strong>
            <div className="annual-leave-warning-list">
              {selectedWeekAnnualLeave.map((leave) => (
                <div key={leave.id}>
                  <strong>{leave.staffName}</strong>
                  {" — "}
                  {formatAnnualLeaveDate(leave.startDate)}
                  {leave.endDate !== leave.startDate &&
                    ` to ${formatAnnualLeaveDate(leave.endDate)}`}
                  {leave.note && <span> — {leave.note}</span>}
                </div>
              ))}
            </div>
          </section>
        )}

        <table className="rota-table">
          <thead>
            <tr>
              <th>Shift</th>
              {dayLabels.map((day) => {
                const dayNotes = getSelectedWeekDayNotes();
                const dayNote =
                  dayNotes?.[day.dayIndex] || dayNotes?.[String(day.dayIndex)] || "";
                const isDaySelected =
                  isEditor && Number(editDayNoteIndex) === Number(day.dayIndex);

                return (
                  <th
                    key={day.dayIndex}
                    onClick={() => loadDayNoteIntoEditor(day.dayIndex)}
                    className={`${isEditor ? "clickable-day-heading" : ""} ${
                      isDaySelected ? "selected-day-heading" : ""
                    }`}
                    title={isEditor ? "Click to edit this day's note" : ""}
                  >
                    <div>{day.label}</div>
                    {dayNote && <div className="day-note">{dayNote}</div>}
                  </th>
                );
              })}
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
                  const vacantSlots = override?.vacantSlots ?? rota?.[day.dayIndex]?.[shift]?.vacantSlots ?? 0;

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
                        staff.map((person) => (
                          <div
                            key={person}
                            className={isLoggedInEmployeeName(person) ? "logged-in-staff-name" : ""}
                          >
                            {person}
                          </div>
                        ))
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
              <h4
                onClick={() => loadDayNoteIntoEditor(day.dayIndex)}
                className={
                  isEditor && Number(editDayNoteIndex) === Number(day.dayIndex)
                    ? "selected-day-heading"
                    : ""
                }
                title={isEditor ? "Tap to edit this day's note" : ""}
              >
                <span>{day.label}</span>
                {(() => {
                  const dayNotes = getSelectedWeekDayNotes();
                  const dayNote =
                    dayNotes?.[day.dayIndex] || dayNotes?.[String(day.dayIndex)] || "";
                  return dayNote ? <span className="day-note">{dayNote}</span> : null;
                })()}
              </h4>

              {SHIFTS.map((shift) => {
                const override = overrides?.[day.dayIndex]?.[shift];

                const staff =
                  override?.staff ?? rota?.[day.dayIndex]?.[shift]?.staff ?? [];

                const note = override?.note || "";
                const vacantSlots = override?.vacantSlots ?? rota?.[day.dayIndex]?.[shift]?.vacantSlots ?? 0;

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
                        staff.map((person) => (
                          <span
                            key={person}
                            className={isLoggedInEmployeeName(person) ? "logged-in-staff-name" : ""}
                          >
                            {person}
                          </span>
                        ))
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
          <>
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

            <RotaStaffPicker
              employees={isAdmin ? employees : staffDirectory}
              value={editStaffText.split("\n").map((name) => name.trim()).filter(Boolean)}
              onChange={(staff) => setEditStaffText(staff.join("\n"))}
              allowShadow
            />

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

          <section className="editor-panel day-note-editor">
            <h2>Day Note</h2>
            <p className="note">
              Add a short note for the whole day. Click a day heading above to select it.
            </p>

            <div className="day-note-editor-grid">
              <label>
                Day
                <select
                  value={editDayNoteIndex ?? ""}
                  onChange={(e) => {
                    if (!e.target.value) {
                      setEditDayNoteIndex(null);
                      setEditDayNote("");
                      return;
                    }
                    const dayIndex = Number(e.target.value);
                    loadDayNoteIntoEditor(dayIndex);
                  }}
                >
                  <option value="">Select a day</option>
                  {DAYS.map((day) => (
                    <option key={day.dayIndex} value={day.dayIndex}>
                      {day.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="day-note-input-label">
                Day Note
                <input
                  value={editDayNote}
                  onChange={(e) => setEditDayNote(e.target.value)}
                  placeholder="e.g. Staff Meeting / New Meds"
                />
              </label>
            </div>

            <div className="editor-actions">
              <button type="button" onClick={saveDayNote} disabled={!editDayNoteIndex}>
                Save Day Note
              </button>
              <button
                type="button"
                className="danger"
                onClick={clearDayNote}
                disabled={!editDayNoteIndex}
              >
                Clear Day Note
              </button>
            </div>
          </section>
          </>
        )}
              </>
            )}
          </>
        )}
        {isEditor && adminView === "archive" && (
          <>
            <SectionNotice section="archive" title="Rota archive" />
            {/* <h2 className="base-editor-title">Rota Archive</h2> */}

            {archiveLoading ? (
              <p className="loading-text">Loading archived rotas...</p>
            ) : !selectedArchive ? (
              <section className="editor-panel">
                <p>No rota weeks have been archived yet.</p>
              </section>
            ) : (
              <>
                <table className="rota-table">
                  <thead>
                    <tr>
                      <th>Shift</th>
                      {archiveDayLabels.map((day) => {
                        const archivedDay = selectedArchive.days.find(
                          (item) => item.dayIndex === day.dayIndex
                        );
                        return (
                          <th key={day.dayIndex}>
                            <div>{day.label}</div>
                            {archivedDay?.dayNote && (
                              <div className="day-note">{archivedDay.dayNote}</div>
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>

                  <tbody>
                    {SHIFTS.map((shift) => (
                      <tr key={shift}>
                        <th>{shift}</th>

                        {selectedArchive.days.map((day) => {
                          const archivedShift = day.shifts.find(
                            (item) => item.shift === shift
                          );
                          const staff = archivedShift?.staff || [];
                          const note = archivedShift?.note || "";
                          const vacantSlots =
                            archivedShift?.vacantSlots || 0;

                          return (
                            <td key={`${day.dayIndex}-${shift}`}>
                              {staff.length > 0 ? (
                                staff.map((person) => (
                                  <div key={person}>{person}</div>
                                ))
                              ) : (
                                <span className="empty-cell">—</span>
                              )}

                              {vacantSlots > 0 && (
                                <div className="vacant">
                                  VACANT x{vacantSlots}
                                </div>
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
                  {selectedArchive.days.map((day) => (
                    <section
                      key={day.dayIndex}
                      className="mobile-day-card"
                    >
                      <h4>
                        <span>{formatDayLabel(parseLocalDate(day.date))}</span>
                        {day.dayNote && (
                          <span className="day-note">{day.dayNote}</span>
                        )}
                      </h4>

                      {day.shifts.map((archivedShift) => (
                        <div
                          key={`${day.dayIndex}-${archivedShift.shift}`}
                          className="mobile-shift-card"
                        >
                          <span className="mobile-shift-title">
                            {archivedShift.shift}
                          </span>

                          <span className="mobile-shift-staff">
                            {archivedShift.staff.length > 0 ? (
                              archivedShift.staff.map((person) => (
                                <span key={person}>{person}</span>
                              ))
                            ) : (
                              <span className="empty-cell">—</span>
                            )}
                          </span>

                          {archivedShift.vacantSlots > 0 && (
                            <span className="vacant">
                              VACANT x{archivedShift.vacantSlots}
                            </span>
                          )}

                          {archivedShift.note && (
                            <span className="note">
                              {archivedShift.note}
                            </span>
                          )}
                        </div>
                      ))}
                    </section>
                  ))}
                </div>

                <section className="editor-panel">
                  <p>
                    This is a read-only snapshot of the final rota as displayed
                    when the week was live.
                  </p>
                  <p className="note">
                    Archived {new Date(selectedArchive.archivedAt).toLocaleString(
                      "en-GB"
                    )}
                  </p>
                </section>
              </>
            )}
          </>
        )}

        {isAdmin && adminView === "payroll" && (
          <section className="payroll-page">
            {(["employees", "annualLeave", "annualLeaveArchive", "payrollAdjustments", "sickness", "archive"].some((key) => loadStatus[key] !== "ready")) &&
              <div className="payroll-load-guard"><strong>Payroll calculations unavailable until all records are loaded.</strong>
                {[["employees", "Employee register"], ["annualLeave", "Annual leave"], ["annualLeaveArchive", "Annual leave archive"], ["payrollAdjustments", "Payroll adjustments"], ["sickness", "Sickness"], ["archive", "Rota archive"]].map(([key, title]) => <SectionNotice key={key} section={key} title={title} />)}
              </div>}
            <div className="payroll-page-header">
              <button type="button" onClick={() => setAdminView("weekly")}>
                Back to Weekly Rota
              </button>
              <button type="button" className="staff-audit-button" onClick={() => {
                setAuditOpen(true);
                loadAuditEntries(true);
              }}>Audit Log</button>
            </div>

            <section className="editor-panel payroll-period-panel">
              <h2>Payroll Hours</h2>
              <p>
                View a single rota week or calculate hours across a custom date range.
                Archived weeks use their frozen snapshot; live weeks resolve the applicable
                base rota plus weekly overrides. Annual leave is credited from the employee's
                applicable base-rota shifts.
              </p>

              <div className="payroll-mode-toggle">
                <button
                  type="button"
                  className={`payroll-mode-button ${payrollMode === "weekly" ? "active-tab" : ""}`}
                  onClick={() => {
                    setPayrollMode("weekly");
                    setPayrollPreview([]);
                    setPayrollUnmatchedNames([]);
                    setPayrollPeriodLabel("");
                  }}
                >
                  Weekly
                </button>
                <button
                  type="button"
                  className={`payroll-mode-button ${payrollMode === "range" ? "active-tab" : ""}`}
                  onClick={() => {
                    setPayrollMode("range");
                    setPayrollPreview([]);
                    setPayrollUnmatchedNames([]);
                    setPayrollPeriodLabel("");
                  }}
                >
                  Date Range
                </button>
              </div>

              {payrollMode === "weekly" ? (
                <div className="payroll-period-controls">
                  <label>
                    Week Commencing
                    <select
                      value={payrollWeek}
                      onChange={(e) => {
                        setPayrollWeek(e.target.value);
                        setPayrollPreview([]);
                        setPayrollUnmatchedNames([]);
                        setPayrollPeriodLabel("");
                      }}
                    >
                      {payrollWeekOptions.map((week) => (
                        <option key={week.weekStart} value={week.weekStart}>
                          W/C {formatWeekCommencing(week.weekStart)}
                          {week.source === "archive" ? " — Archived" : " — Live"}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : (
                <>
                <div className="payroll-date-grid">
                  <label>
                    Start Date
                    <input
                      type="date"
                      value={payrollStartDate}
                      onChange={(e) => {
                        const value = e.target.value;
                        setPayrollStartDate(value);
                        if (!payrollEndDate || payrollEndDate < value) {
                          setPayrollEndDate(value);
                        }
                        setPayrollPreview([]);
                        setPayrollUnmatchedNames([]);
                        setPayrollPeriodLabel("");
                      }}
                    />
                  </label>
                  <label>
                    End Date
                    <input
                      type="date"
                      min={payrollStartDate || undefined}
                      value={payrollEndDate}
                      onChange={(e) => {
                        setPayrollEndDate(e.target.value);
                        setPayrollPreview([]);
                        setPayrollUnmatchedNames([]);
                        setPayrollPeriodLabel("");
                      }}
                    />
                  </label>
                </div>
                <div className="payroll-range-shortcuts">
                  <button
                    type="button"
                    onClick={() => {
                      const today = new Date();
                      const year = today.getFullYear();
                      const month = today.getMonth();
                      // Payroll runs from the 20th to the following 19th.
                      // On the 20th, advance to the newly started period.
                      const periodStartMonth = today.getDate() >= 20 ? month : month - 1;
                      setPayrollStartDate(toDateId(new Date(year, periodStartMonth, 20)));
                      setPayrollEndDate(toDateId(new Date(year, periodStartMonth + 1, 19)));
                      setPayrollPreview([]);
                      setPayrollUnmatchedNames([]);
                      setPayrollPeriodLabel("");
                    }}
                  >
                    Quick Select | Current Payroll Period 
                  </button>
                </div>
                </>
              )}

              <div className="payroll-calculate-actions">
                <button
                  type="button"
                  onClick={generatePayrollPreview}
                  disabled={
                    payrollPreviewLoading ||
                    ["employees", "annualLeave", "annualLeaveArchive", "payrollAdjustments", "sickness", "archive"].some((key) => loadStatus[key] !== "ready") ||
                    (payrollMode === "weekly" ? !payrollWeek : !payrollStartDate || !payrollEndDate)
                  }
                >
                  {payrollPreviewLoading ? "Calculating..." : "Calculate Hours"}
                </button>
                <button
                  type="button"
                  onClick={handlePayrollPdf}
                  disabled={payrollPreview.length === 0 || ["employees", "annualLeave", "annualLeaveArchive", "payrollAdjustments", "sickness", "archive"].some((key) => loadStatus[key] !== "ready")}
                >
                  Output Payroll PDF
                </button>
              </div>

              <div className="payroll-shift-key">
                {SHIFTS.map((shift) => (
                  <span key={shift}>
                    <strong>{shift.replace("\n", " ")}</strong>: {PAYROLL_SHIFT_HOURS[shift]}h
                  </span>
                ))}
              </div>

              {payrollPeriodLabel && payrollPreview.length > 0 && (
                <h3 className="payroll-result-period">{payrollPeriodLabel}</h3>
              )}

              {payrollUnmatchedNames.length > 0 && (
                <div className="payroll-warning">
                  <strong>Unmatched rota names</strong>
                  <p>
                    These names were found on the rota but do not match an employee
                    name or alias, so their hours are not included yet:
                  </p>
                  <div>{payrollUnmatchedNames.join(", ")}</div>
                </div>
              )}

              {payrollPreview.length > 0 && (
                <div className="payroll-employee-table-wrap">
                  <table className="payroll-employee-table payroll-preview-table">
                    <thead>
                      <tr>
                        <th>Employee</th><th>Shifts</th><th>Worked</th><th>A/L</th>
                        {payrollPeriodHasSickness && <th>Sick*</th>}
                        {payrollPeriodHasAdjustments && <th>Adj.</th>}
                        <th>Accounted</th><th>Contract</th><th>Variance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payrollPreview.map((row) => (
                        <tr key={row.employeeId}>
                          <td><strong>{row.displayName}</strong></td>
                          <td>{row.shiftsWorked}</td>
                          <td>
                            {row.workedHours}h
                            {row.actualHoursOverrideDates?.length > 0 && (
                              <div className="payroll-override-indicator" title={row.actualHoursOverrideDates.map((item) => `${formatAnnualLeaveDate(item.date)}: rota ${item.rotaHours}h → actual ${item.actualHours}h`).join("\n")}>
                                Rota {row.rotaWorkedHours}h · overridden
                              </div>
                            )}
                          </td>
                          <td>{row.annualLeaveHours}h</td>
                          {payrollPeriodHasSickness && <td title="Informational only; excluded from accounted hours">{row.sicknessHours}h</td>}
                          {payrollPeriodHasAdjustments && (
                            <td>{row.adjustmentHours > 0 ? "+" : ""}{row.adjustmentHours}h</td>
                          )}
                          <td>{row.accountedHours}h</td>
                          <td>{Number(row.contractedHours.toFixed(2))}h</td>
                          <td className={row.varianceHours > 0 ? "payroll-positive" : row.varianceHours < 0 ? "payroll-negative" : ""}>
                            {row.varianceHours > 0 ? "+" : ""}{Number(row.varianceHours.toFixed(2))}h
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                                {payrollPreview.length > 0 && payrollPeriodHasSickness && <p className="note">* Sick hours are informational only and are excluded from Accounted hours and from being calculated in Variance. SSP assessed by accountant.</p>}
                </div>
              )}
            </section>

            <section className="editor-panel sickness-panel">
              <h2>Sickness Absence</h2>
              <p>Record dates and confirm scheduled hours missed. These hours are reported to the accountant, not added to payroll or used to calculate SSP. Remove fully absent staff from the live rota; for early departures, retain their shift and use an actual-hours override.</p>
              <form onSubmit={saveSicknessAbsence}>
                <div className="payroll-form-grid">
                  <label>Employee
                    <select value={sicknessEmployeeId} onChange={(e) => { setSicknessEmployeeId(e.target.value); setSicknessHoursByDate({}); setSicknessSuggestionDetails({}); }} required>
                      <option value="">Select employee</option>
                      {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}
                    </select>
                  </label>
                  <label>Start Date<input type="date" value={sicknessStartDate} onChange={(e) => { setSicknessStartDate(e.target.value); setSicknessHoursByDate({}); setSicknessSuggestionDetails({}); }} required /></label>
                  <label>End Date<input type="date" min={sicknessStartDate || undefined} value={sicknessEndDate} onChange={(e) => { setSicknessEndDate(e.target.value); setSicknessHoursByDate({}); setSicknessSuggestionDetails({}); }} required /></label>
                  <label>Administrative Note (no medical details)<input value={sicknessNote} onChange={(e) => setSicknessNote(e.target.value)} placeholder="e.g. sickness reported / left early" /></label>
                </div>
                <div className="editor-actions sickness-primary-actions">
                  <button type="button" onClick={suggestSicknessHours} disabled={sicknessLoading}>{sicknessLoading ? "Comparing..." : "Compare Rota Sources"}</button>
                  {Object.keys(sicknessHoursByDate).length === 0 && (
                    <button type="submit" disabled>{editingSicknessId ? "Save Sickness Changes" : "Save Sickness Record"}</button>
                  )}
                  {Object.keys(sicknessHoursByDate).length === 0 && editingSicknessId && <button type="button" onClick={clearSicknessForm}>Cancel Edit</button>}
                </div>
                {Object.keys(sicknessHoursByDate).length > 0 && (
                  <div className="payroll-employee-table-wrap sickness-comparison-table">
                    <table className="payroll-employee-table">
                      <thead><tr><th>Date</th><th>Base</th><th>Final</th><th>Worked</th><th>Missed hours (confirm)</th><th>Review</th></tr></thead>
                      <tbody>
                        {getAnnualLeaveDateIds(sicknessStartDate, sicknessEndDate).map((date) => {
                          const detail = sicknessSuggestionDetails[date] || {};
                          return <tr key={date}>
                            <td>{parseLocalDate(date).toLocaleDateString("en-GB", { weekday: "short" })}, {formatAnnualLeaveDate(date)}</td>
                            <td>{detail.baseHours ?? "—"}h</td>
                            <td>{detail.finalHours === null || detail.finalHours === undefined ? "—" : `${detail.finalHours}h`}</td>
                            <td>{detail.worked ?? "—"}h</td>
                            <td><input aria-label={`Missed hours ${date}`} type="number" min="0" max="24" step="0.25" value={sicknessHoursByDate[date] ?? ""} onChange={(e) => setSicknessHoursByDate((current) => ({ ...current, [date]: e.target.value }))} /></td>
                            <td>{detail.leaveOverlap ? "A/L conflict" : detail.existingOverlap ? "Sickness overlap" : detail.review ? "Check manually" : "—"}</td>
                          </tr>;
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {Object.keys(sicknessHoursByDate).length > 0 && (
                  <div className="editor-actions sickness-confirm-actions">
                    <button type="submit" disabled={sicknessLoading}>{editingSicknessId ? "Save Sickness Changes" : "Save Sickness Record"}</button>
                    {editingSicknessId && <button type="button" onClick={clearSicknessForm}>Cancel Edit</button>}
                  </div>
                )}
              </form>
              {sicknessAbsences.some((record) => record.endDate >= getPayrollArchiveCutoffId()) && <div className="payroll-employee-table-wrap">
                <table className="payroll-employee-table">
                  <thead><tr><th>Employee</th><th>Dates</th><th>Missed Hours</th><th>Note</th><th>Actions</th></tr></thead>
                  <tbody>{sicknessAbsences.filter((record) => record.endDate >= getPayrollArchiveCutoffId()).map((record) => <tr key={record.id}>
                    <td>{record.displayName}</td>
                    <td>{formatAnnualLeaveDate(record.startDate)} – {formatAnnualLeaveDate(record.endDate)}</td>
                    <td>{Number(Object.values(record.absenceHoursByDate || {}).reduce((total, hours) => total + Number(hours || 0), 0).toFixed(2))}h</td>
                    <td>{record.note || "—"}</td>
                    <td><div className="payroll-row-actions"><button type="button" onClick={() => editSicknessAbsence(record)}>Edit</button><button type="button" className="danger" onClick={() => deleteSicknessAbsence(record)}>Delete</button></div></td>
                  </tr>)}</tbody>
                </table>
              </div>}
            </section>

            <section className="editor-panel payroll-actual-overrides">
              <h2>Actual Hours Overrides</h2>
              <p>Use this only where the final rota differs from the hours actually worked. The override replaces that employee's rota-derived worked hours for the selected date; it does not add extra hours.</p>

              <form onSubmit={saveActualHoursOverride}>
                <div className="payroll-form-grid">
                  <label>
                    Employee
                    <select value={actualOverrideEmployeeId} onChange={(e) => setActualOverrideEmployeeId(e.target.value)}>
                      <option value="">Select employee</option>
                      {employees.filter((employee) => employee.active !== false).map((employee) => (
                        <option key={employee.id} value={employee.id}>{employee.displayName}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Date
                    <input type="date" value={actualOverrideDate} onChange={(e) => setActualOverrideDate(e.target.value)} />
                  </label>
                  <label>
                    Actual Hours Worked
                    <input type="number" min="0" step="0.25" value={actualOverrideHours} onChange={(e) => setActualOverrideHours(e.target.value)} placeholder="e.g. 0 or 11" />
                  </label>
                  <label>
                    Reason / Note
                    <input value={actualOverrideNote} onChange={(e) => setActualOverrideNote(e.target.value)} placeholder="e.g. Off-Standard Shift / Short Shift" />
                  </label>
                </div>
                <div className="editor-actions">
                  <button type="submit">{editingActualOverrideId ? "Save Override Changes" : "Add Actual Hours Override"}</button>
                  {editingActualOverrideId && <button type="button" onClick={clearActualHoursOverrideForm}>Cancel Edit</button>}
                </div>
              </form>

              {actualHoursOverrides.filter((item) => item.date >= getPayrollArchiveCutoffId()).length > 0 && (
                <div className="payroll-employee-table-wrap">
                  <table className="payroll-employee-table">
                    <thead><tr><th>Date</th><th>Employee</th><th>Actual Hours</th><th>Reason</th><th>Actions</th></tr></thead>
                    <tbody>
                      {actualHoursOverrides.filter((item) => item.date >= getPayrollArchiveCutoffId()).map((override) => (
                        <tr key={override.id}>
                          <td>{formatAnnualLeaveDate(override.date)}</td>
                          <td>{override.displayName || employees.find((employee) => employee.id === override.employeeId)?.displayName || "—"}</td>
                          <td>{override.hours}h</td>
                          <td>{override.note || "—"}</td>
                          <td><div className="payroll-row-actions"><button type="button" onClick={() => editActualHoursOverride(override)}>Edit</button><button type="button" className="danger" onClick={() => deleteActualHoursOverride(override)}>Delete</button></div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="editor-panel payroll-adjustments">
              <h2>Payroll Adjustments</h2>
              <p>Add dated hour adjustments for one or more employees. These are included separately from worked hours and annual leave.</p>

              <form onSubmit={savePayrollAdjustment}>
                <div className="payroll-form-grid">
                  <label>
                    Date
                    <input type="date" value={adjustmentDate} onChange={(e) => setAdjustmentDate(e.target.value)} />
                  </label>
                  <label>
                    Hours
                    <input type="number" min="0.25" step="0.25" value={adjustmentHours} onChange={(e) => setAdjustmentHours(e.target.value)} placeholder="e.g. 2" />
                  </label>
                  <label>
                    Description / Note
                    <input value={adjustmentNote} onChange={(e) => setAdjustmentNote(e.target.value)} placeholder=" e.g. Meeting / Training" />
                  </label>
                </div>

                <div className="payroll-adjustment-employees">
                  <strong>Employees</strong>
                  {employees.filter((employee) => employee.active !== false).map((employee) => (
                    <label key={employee.id} className="payroll-adjustment-checkbox">
                      <input
                        type="checkbox"
                        checked={adjustmentEmployeeIds.includes(employee.id)}
                        onChange={() => toggleAdjustmentEmployee(employee.id)}
                      />
                      {employee.displayName}
                    </label>
                  ))}
                </div>

                <div className="editor-actions">
                  <button type="submit">{editingAdjustmentId ? "Save Adjustment Changes" : "Add Adjustment"}</button>
                  {editingAdjustmentId && <button type="button" onClick={clearPayrollAdjustmentForm}>Cancel Edit</button>}
                </div>
              </form>

              {payrollAdjustments.filter((item) => item.date >= getPayrollArchiveCutoffId()).length > 0 && (
                <div className="payroll-employee-table-wrap">
                  <table className="payroll-employee-table">
                    <thead><tr><th>Date</th><th>Hours</th><th>Employees</th><th>Note</th><th>Actions</th></tr></thead>
                    <tbody>
                      {payrollAdjustments.filter((item) => item.date >= getPayrollArchiveCutoffId()).map((adjustment) => (
                        <tr key={adjustment.id}>
                          <td>{formatAnnualLeaveDate(adjustment.date)}</td>
                          <td>{adjustment.hours > 0 ? "+" : ""}{adjustment.hours}h</td>
                          <td>{(adjustment.employees || []).map((employee) => employee.displayName).join(", ")}</td>
                          <td>{adjustment.note || "—"}</td>
                          <td><div className="payroll-row-actions"><button type="button" onClick={() => editPayrollAdjustment(adjustment)}>Edit</button><button type="button" className="danger" onClick={() => deletePayrollAdjustment(adjustment)}>Delete</button></div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="editor-panel payroll-register">
              <div className="payroll-section-heading">
                <div>
                  <h2>Employee Register</h2>
                  <p>
                    Payroll matches each rota name against the employee's name and aliases.
                  </p>
                  <p align="left">Contracted hours are per week.</p>
                </div>
                <span className="payroll-employee-count">
                  {employees.filter((employee) => !employee.archived).length} employee{employees.filter((employee) => !employee.archived).length === 1 ? "" : "s"}
                </span>
              </div>

              {employeesLoading ? (
                <p className="loading-text">Loading employee register...</p>
              ) : employees.filter((employee) => !employee.archived).length === 0 ? (
                <p className="payroll-empty">
                  No employees have been added yet. Use Add Employee to create the first staff record.
                </p>
              ) : (
                <div className="payroll-employee-table-wrap employee-register-table-wrap">
                  <table className="payroll-employee-table employee-register-table">
                    <thead>
                      <tr>
                        <th>Rota Name</th>
                        <th>Staff Type</th>
                        <th>Contracted Hours</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {employees.filter((employee) => !employee.archived).map((employee) => (
                        <tr key={employee.id}>
                          <td><strong>{employee.displayName}</strong></td>
                          <td>{getEmployeeStaffType(employee)}</td>
                          <td>{employee.contractedHours ?? "—"}</td>
                          <td>
                            <span
                              className={`payroll-status ${
                                employee.active === false ? "inactive" : "active"
                              }`}
                            >
                              {employee.active === false ? "Inactive" : "Active"}
                            </span>
                          </td>
                          <td>
                            <div className="payroll-row-actions employee-register-actions">
                              <button type="button" onClick={() => editEmployee(employee)}>
                                Edit
                              </button>
                              <button
                                type="button"
                                className="danger"
                                onClick={() => archiveEmployee(employee)}
                              >
                                Archive
                              </button>
                              <button type="button" onClick={() => openAccountManager(employee)}>
                                Account
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {isAdmin && accountEmployee && (
              <div className="modalOverlay account-modal-overlay">
                <div className="modal account-manager-modal">
                  <div className="account-manager-heading">
                    <div><h2>{accountEmployee.authUid ? "Manage Login" : "Create Login"}</h2><p>{accountEmployee.displayName}</p></div>
                    <button type="button" className="annual-leave-close" onClick={closeAccountManager} aria-label="Close login manager">×</button>
                  </div>
                  <div className="account-login-summary">
                    <div>
                      <span className="account-summary-label">Login Account</span>
                      {accountEmployee.authUid ? (
                        <div className="account-status-stack">
                          <span className={`payroll-status ${accountEmployee.accountEnabled === false ? "inactive" : "active"}`}>
                            {accountEmployee.accountEnabled === false ? "Disabled" : "Enabled"}
                          </span>
                          <span className="account-username">@{accountEmployee.username || accountUsername || "unknown"}</span>
                          {accountEmployee.mustChangePassword && (
                            <span className="account-password-required">Password change required</span>
                          )}
                        </div>
                      ) : (
                        <span className="payroll-status inactive">No login created</span>
                      )}
                    </div>
                  </div>
                  <div className="account-manager-form">
                    <label>Username
                      <input value={accountUsername} onChange={(e) => setAccountUsername(normaliseAccountUsername(e.target.value))}
                        disabled={Boolean(accountEmployee.authUid) || accountActionLoading} placeholder="e.g. caldridge" autoCapitalize="none" autoCorrect="off" />
                    </label>
                    <label>Access Role
                      <select value={accountRoleDraft} onChange={(e) => setAccountRoleDraft(e.target.value)} disabled={accountActionLoading}>
                        <option value="staff">Staff</option><option value="senior">Senior</option>
                      </select>
                    </label>
                    <label>{accountEmployee.authUid ? "New Temporary Password" : "Temporary Password"}
                      <input type="password" value={temporaryPassword} onChange={(e) => setTemporaryPassword(e.target.value)}
                        disabled={accountActionLoading} placeholder="Minimum 8 characters" autoComplete="new-password" />
                    </label>
                    {!accountEmployee.authUid ? (
                      <button type="button" className="account-primary-action" onClick={handleCreateEmployeeAccount} disabled={accountActionLoading}>
                        {accountActionLoading ? "Creating..." : "Create Login Account"}
                      </button>
                    ) : (<>
                      <button type="button" className="account-primary-action" onClick={handleSaveEmployeeAccountAccess} disabled={accountActionLoading}>Save Access Role</button>
                      <button type="button" className={accountEmployee.accountEnabled === false ? "" : "dangerButton"} onClick={() => handleToggleEmployeeAccount(accountEmployee)} disabled={accountActionLoading}>{accountEmployee.accountEnabled === false ? "Enable Login" : "Disable Login"}</button>
                      <button type="button" onClick={handleResetEmployeePassword} disabled={accountActionLoading || temporaryPassword.length < 8}>Reset to Temporary Password</button>
                    </>)}
                  </div>
                </div>
              </div>
            )}

            <div className="employee-register-add-row">
              <button
                type="button"
                className="employee-register-add-button"
                onClick={() => {
                  clearEmployeeForm();
                  setEmployeeEditorOpen(true);
                }}
              >
                Add Employee
              </button>
            </div>

            <div className="staff-archive-footer">
              <div className="staff-archive-divider" />
              <button
                type="button"
                className="annual-leave-history-toggle staff-archive-button"
                onClick={() => setStaffArchiveOpen(true)}
              >
                Staff & Payroll Archive
              </button>
            </div>

            {staffArchiveOpen && (
              <div
                className="modalOverlay account-modal-overlay"
                onMouseDown={(e) => { if (e.target === e.currentTarget) setStaffArchiveOpen(false); }}
              >
                <div className="modal account-manager-modal staff-archive-modal">
                  <div className="account-manager-heading">
                    <div>
                      <h2>Staff & Payroll Archive</h2>
                      <p>Retained records used for historical rota and payroll calculations.</p>
                    </div>
                    <button type="button" className="upcoming-shifts-close" aria-label="Close archive" onClick={() => setStaffArchiveOpen(false)}>×</button>
                  </div>

                  <section className="staff-archive-section">
                    <h3>Archived Staff</h3>
                    {employees.filter((employee) => employee.archived).length === 0 ? (
                      <p className="payroll-empty">No staff have been archived.</p>
                    ) : (
                      <div className="payroll-employee-table-wrap">
                        <table className="payroll-employee-table">
                          <thead><tr><th>Rota Name</th><th>Staff Type</th><th>Contract</th><th>Action</th></tr></thead>
                          <tbody>
                            {employees.filter((employee) => employee.archived).map((employee) => (
                              <tr key={employee.id}>
                                <td><strong>{employee.displayName}</strong></td>
                                <td>{getEmployeeStaffType(employee)}</td>
                                <td>{employee.contractedHours ?? "—"}h</td>
                                <td><button type="button" onClick={() => restoreArchivedEmployee(employee)}>Restore</button></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>

                  <section className="staff-archive-section">
                    <h3>Payroll Adjustments — over 5 weeks old</h3>
                    {payrollAdjustments.filter((item) => item.date < getPayrollArchiveCutoffId()).length === 0 ? (
                      <p className="payroll-empty">No archived payroll adjustments.</p>
                    ) : (
                      <div className="payroll-employee-table-wrap">
                        <table className="payroll-employee-table">
                          <thead><tr><th>Date</th><th>Hours</th><th>Employees</th><th>Note</th></tr></thead>
                          <tbody>
                            {payrollAdjustments.filter((item) => item.date < getPayrollArchiveCutoffId()).map((adjustment) => (
                              <tr key={adjustment.id}>
                                <td>{formatAnnualLeaveDate(adjustment.date)}</td>
                                <td>+{adjustment.hours}h</td>
                                <td>{(adjustment.employees || []).map((employee) => employee.displayName).join(", ")}</td>
                                <td>{adjustment.note || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>

                  <section className="staff-archive-section">
                    <h3>Actual Hours Overrides — over 5 weeks old</h3>
                    {actualHoursOverrides.filter((item) => item.date < getPayrollArchiveCutoffId()).length === 0 ? (
                      <p className="payroll-empty">No archived actual-hours overrides.</p>
                    ) : (
                      <div className="payroll-employee-table-wrap">
                        <table className="payroll-employee-table">
                          <thead><tr><th>Date</th><th>Employee</th><th>Actual Hours</th><th>Reason</th></tr></thead>
                          <tbody>
                            {actualHoursOverrides.filter((item) => item.date < getPayrollArchiveCutoffId()).map((override) => (
                              <tr key={override.id}>
                                <td>{formatAnnualLeaveDate(override.date)}</td>
                                <td>{override.displayName || employees.find((employee) => employee.id === override.employeeId)?.displayName || "—"}</td>
                                <td>{override.hours}h</td>
                                <td>{override.note || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>

                  <section className="staff-archive-section">
                    <h3>Sickness Absence — over 5 weeks old</h3>
                    <p className="staff-archive-section-note">
                      Records appear here once the absence end date is more than five weeks old.
                      Confirmed daily missed hours remain available for historical payroll.
                    </p>
                    {sicknessAbsences.filter((record) => record.endDate < getPayrollArchiveCutoffId()).length === 0 ? (
                      <p className="payroll-empty">No archived sickness absence records.</p>
                    ) : (
                      <div className="payroll-employee-table-wrap">
                        <table className="payroll-employee-table">
                          <thead><tr><th>Employee</th><th>Dates</th><th>Missed Hours</th><th>Note</th><th>Actions</th></tr></thead>
                          <tbody>
                            {sicknessAbsences.filter((record) => record.endDate < getPayrollArchiveCutoffId()).map((record) => (
                              <tr key={record.id}>
                                <td>{record.displayName}</td>
                                <td>{formatAnnualLeaveDate(record.startDate)} – {formatAnnualLeaveDate(record.endDate)}</td>
                                <td>{Number(Object.values(record.absenceHoursByDate || {}).reduce((total, hours) => total + Number(hours || 0), 0).toFixed(2))}h</td>
                                <td>{record.note || "—"}</td>
                                <td>
                                  <div className="payroll-row-actions">
                                    <button type="button" onClick={() => {
                                      setStaffArchiveOpen(false);
                                      editSicknessAbsence(record);
                                      window.requestAnimationFrame(() => document.querySelector(".sickness-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }));
                                    }}>Edit</button>
                                    <button type="button" className="danger" onClick={() => deleteSicknessAbsence(record)}>Delete</button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>

                  <section className="staff-archive-section">
                    <h3>Annual Leave — previous calendar years</h3>
                    <p className="staff-archive-section-note">
                    </p>
                    {annualLeaveArchive.length === 0 ? (
                      <p className="payroll-empty">No annual leave has been archived.</p>
                    ) : (
                      <div className="payroll-employee-table-wrap">
                        <table className="payroll-employee-table">
                          <thead>
                            <tr>
                              <th>Year</th>
                              <th>Employee</th>
                              <th>Dates</th>
                              <th>Paid A/L</th>
                              <th>Note</th>
                            </tr>
                          </thead>
                          <tbody>
                            {annualLeaveArchive.map((leave) => (
                              <tr key={leave.id}>
                                <td>{leave.archiveYear || String(leave.endDate || "").slice(0, 4) || "—"}</td>
                                <td><strong>{leave.staffName}</strong></td>
                                <td>
                                  {formatAnnualLeaveDate(leave.startDate)}
                                  {leave.endDate !== leave.startDate &&
                                    ` to ${formatAnnualLeaveDate(leave.endDate)}`}
                                </td>
                                <td>{Number(leave.leaveHours || 0)}h</td>
                                <td>{leave.note || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                </div>
              </div>
            )}

            {employeeEditorOpen && (
              <div
                className="modalOverlay account-modal-overlay"
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) {
                    clearEmployeeForm();
                    setEmployeeEditorOpen(false);
                  }
                }}
              >
                <div className="modal account-manager-modal employee-editor-modal">
                  <div className="account-manager-heading">
                    <div>
                      <h2>{editingEmployeeId ? "Edit Employee" : "Add Employee"}</h2>
                      <p>
                        {editingEmployeeId
                          ? "Update this employee's rota details."
                          : "Add a new employee to the staff register."}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="upcoming-shifts-close"
                      aria-label="Close employee editor"
                      onClick={() => {
                        clearEmployeeForm();
                        setEmployeeEditorOpen(false);
                      }}
                    >
                      ×
                    </button>
                  </div>

                  <form onSubmit={saveEmployee}>
                    <div className="payroll-form-grid employee-editor-grid">
                      <label className="employee-field-name">
                        Rota Name
                        <input
                          value={employeeName}
                          onChange={(e) => setEmployeeName(e.target.value)}
                          placeholder="e.g. K Sandbrook"
                        />
                      </label>

                      <label className="employee-field-hours">
                        Contract Hrs/Wk
                        <input
                          type="number"
                          min="0"
                          step="0.5"
                          value={employeeContractedHours}
                          onChange={(e) => setEmployeeContractedHours(e.target.value)}
                          placeholder="e.g. 30"
                        />
                      </label>

                      <label className="employee-field-date">
                        Contract effective from
                        <input type="date" value={employeeContractEffectiveFrom}
                          onChange={(e) => setEmployeeContractEffectiveFrom(e.target.value)} />
                      </label>
                      <label className="employee-field-type">
                        Staff Type (optional override)
                        <input type="text" value={employeeStaffType} onChange={(e) => setEmployeeStaffType(e.target.value)}
                          placeholder={editingEmployeeId ? getEmployeeStaffType(employees.find((e) => e.id === editingEmployeeId)) : "Staff"}
                          maxLength={60} />
                        <small>Automatically follows the linked account role when blank. Enter a title such as Manager to override the display.</small>
                      </label>
                      <label className="employee-field-status">
                        Employment Status
                        <select
                          value={employeeActive ? "active" : "inactive"}
                          onChange={(e) => setEmployeeActive(e.target.value === "active")}
                        >
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                        </select>
                      </label>
                    </div>

                    <label className="editor-full">
                      Rota Aliases
                      <textarea
                        value={employeeAliases}
                        onChange={(e) => setEmployeeAliases(e.target.value)}
                        rows="4"
                        placeholder={"One alias per line e.g.\nTrina"}
                      />
                    </label>

                    <p className="note" style={{ fontSize: "14px" }}>
                      Aliases recognise historical or alternative rota names without
                      changing the rota itself.
                    </p>
                    {editingEmployeeId && (() => {
                      const employee = employees.find((item) => item.id === editingEmployeeId);
                      const history = employee?.contractHistory || [];
                      return (
                        <div className="contract-history-panel">
                          <strong>Contract history</strong>
                          <p className="note">Existing contract: {employee?.baselineContractedHours ?? employee?.contractedHours ?? 0}h/week before the first recorded change. Changes take effect on the recorded calendar date.</p>
                          {history.length > 0 ? (
                            <ul>{history.map((entry) => (
                              <li key={entry.effectiveFrom}>From {formatAnnualLeaveDate(entry.effectiveFrom)} — {entry.hours}h/week</li>
                            ))}</ul>
                          ) : <p className="note">No dated contract changes recorded yet.</p>}
                        </div>
                      );
                    })()}


                    <div className="editor-actions employee-editor-actions">
                      <button type="submit">
                        {editingEmployeeId ? "Save Employee Changes" : "Add Employee"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          clearEmployeeForm();
                          setEmployeeEditorOpen(false);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </section>
        )}

        {isEditor && adminView === "base" && (
          <>
            <h2 className="base-editor-title">Base Rota Editor{basePatternLength === 2 ? ` — Week ${baseTemplateWeek}` : ""}</h2>

            <section className="editor-panel base-version-panel">
              <h2>Change Effective Date</h2>
              <p>
                Changes saved here apply from the selected week onwards. Earlier
                weeks keep the base rota that was active at the time.
              </p>

              <div className="editor-full base-effective-select">
                <div className="base-effective-heading" id="base-effective-label">Effective from week commencing</div>
                {(() => {
                  const last = [...weeks].map(normaliseWeekId).filter(Boolean).sort().at(-1);
                  const next = last ? toDateId(addDays(last, 7)) : currentWeekId;
                  const options = allowGeneratedBaseWeeks
                    ? [...new Set([...weeks.map(normaliseWeekId).filter((id) => id >= currentWeekId), next, baseEffectiveFrom])]
                    : [...new Set([next, ...(baseEffectiveFrom > next ? [baseEffectiveFrom] : [])])];
                  return (
                    <select
                      className="base-effective-native-select"
                      aria-labelledby="base-effective-label"
                      value={baseEffectiveFrom}
                      onChange={(e) => loadBaseEditorForWeek(e.target.value)}
                    >
                      {options.filter(Boolean).sort().map((id) => (
                        <option key={id} value={id}>
                          {`W/C ${formatWeekCommencing(id)}${id === next ? " — Next generated week" : ""}`}
                        </option>
                      ))}
                    </select>
                  );
                })()}
              </div>

              <label className="base-generated-toggle">
                <input type="checkbox" checked={allowGeneratedBaseWeeks}
                  onChange={(e) => {
                    setAllowGeneratedBaseWeeks(e.target.checked);
                    const last = [...weeks].map(normaliseWeekId).filter(Boolean).sort().at(-1);
                    if (!e.target.checked && last) loadBaseEditorForWeek(toDateId(addDays(last, 7)));
                  }} /> <span>Allow changes within already-generated weeks</span>
              </label>
              <p className="note">
                {editingBaseVersionId
                  ? "Editing a saved base-rota version."
                  : "No saved change exists for this week yet. The first save will create one."}
              </p>
            </section>

            <section className="editor-panel base-pattern-panel">
              <h2>Base Rota Pattern</h2>
              <p>Choose whether this effective-dated base rota repeats every week or alternates over two weeks.</p>

              <div className="base-pattern-toggle">
                <button
                  type="button"
                  className={basePatternLength === 1 ? "active-tab" : ""}
                  onClick={() => {
                    setBasePatternLength(1);
                    setBaseTemplateWeek(1);
                  }}
                >
                  1 Week
                </button>
                <button
                  type="button"
                  className={basePatternLength === 2 ? "active-tab" : ""}
                  onClick={() => {
                    if (basePatternLength !== 2 && Object.keys(baseEditorWeek2Rota).length === 0) {
                      setBaseEditorWeek2Rota(baseEditorRota);
                    }
                    setBasePatternLength(2);
                  }}
                >
                  2 Weeks
                </button>
              </div>

              {basePatternLength === 2 && (
                <>
                  <p className="note">The effective-from week is Week 1. The following calendar week is Week 2, then the pattern repeats.</p>
                  <div className="base-pattern-toggle template-week-toggle">
                    <button
                      type="button"
                      className={baseTemplateWeek === 1 ? "active-tab" : ""}
                      onClick={() => setBaseTemplateWeek(1)}
                    >
                      Edit Week 1
                    </button>
                    <button
                      type="button"
                      className={baseTemplateWeek === 2 ? "active-tab" : ""}
                      onClick={() => setBaseTemplateWeek(2)}
                    >
                      Edit Week 2
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className="editor-panel pending-base-changes">
              <h2>Pending Base Rota Changes</h2>
              {baseVersions.filter(
                (version) => version.effectiveFrom > currentWeekId
              ).length === 0 ? (
                <p>No pending changes.</p>
              ) : (
                baseVersions
                  .filter((version) => version.effectiveFrom > currentWeekId)
                  .map((version) => (
                    <div className="pending-change-row" key={version.id}>
                      <span>
                        Applies from W/C {formatWeekCommencing(version.effectiveFrom)} — {getVersionPatternLength(version) === 2 ? "2-week pattern" : "1-week pattern"}
                      </span>
                      <div className="editor-actions">
                        <button
                          type="button"
                          onClick={() => loadBaseEditorForWeek(version.effectiveFrom)}
                        >
                          Review / Amend
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => cancelBaseVersion(version.id)}
                        >
                          Cancel Change
                        </button>
                      </div>
                    </div>
                  ))
              )}
            </section>

            {baseEditorLoading ? (
              <p className="loading-text">Loading base rota version...</p>
            ) : (
            <>
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
                      const activeBaseEditorRota = baseTemplateWeek === 2 ? baseEditorWeek2Rota : baseEditorRota;
                      const base = activeBaseEditorRota?.[day.dayIndex]?.[shift];
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
                            Number(base?.vacantSlots) > 0 ? null : <span className="empty-cell">—</span>
                          )}
                          {Number(base?.vacantSlots) > 0 && <div className="vacant">VACANT x{base.vacantSlots}</div>}
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
                    const activeBaseEditorRota = baseTemplateWeek === 2 ? baseEditorWeek2Rota : baseEditorRota;
                    const base = activeBaseEditorRota?.[day.dayIndex]?.[shift];
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
                            Number(base?.vacantSlots) > 0 ? null : <span className="empty-cell">—</span>
                          )}
                          {Number(base?.vacantSlots) > 0 && <span className="vacant">VACANT x{base.vacantSlots}</span>}
                        </span>
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
            </>
            )}

            <section className="editor-panel">
              <h2>Base Shift Editor</h2>

              <div className="editor-grid base-shift-editor-grid">
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
              <label className="base-vacancy-field">
                Vacant Slots
                <input type="number" min="0" step="1" value={baseVacantSlots}
                  onChange={(e) => setBaseVacantSlots(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
              </label>

              </div>

              <RotaStaffPicker
                employees={isAdmin ? employees : staffDirectory}
                value={baseStaffText.split("\n").map((name) => name.trim()).filter(Boolean)}
                onChange={(staff) => setBaseStaffText(staff.join("\n"))}
              />

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

      {(adminView === "weekly" || adminView === "base" || adminView === "payroll") && upcomingShiftsSidebarOpen && (
        <>
          <div
            className="upcoming-shifts-sidebar-backdrop"
            onClick={() => setUpcomingShiftsSidebarOpen(false)}
          />
          <aside className="upcoming-shifts-sidebar" aria-label="Upcoming shifts">
            <div className="upcoming-shifts-sidebar-header">
              <div>
                <h2>{hasPersonalUpcomingShifts ? "My Upcoming Shifts" : "Upcoming Shifts"}</h2>
                <p>
                  {hasPersonalUpcomingShifts
                    ? "Your shifts across the rotas currently available."
                    : "Choose a staff member to view their upcoming shifts."}
                </p>
              </div>
              <button
                type="button"
                className="upcoming-shifts-close"
                onClick={() => setUpcomingShiftsSidebarOpen(false)}
                aria-label="Close upcoming shifts"
              >
                ×
              </button>
            </div>

            <div className="upcoming-shifts-sidebar-content">
              {!hasPersonalUpcomingShifts && (
                <label className="viewer-employee-select">
                  Staff Name
                  <select
                    value={viewerEmployeeId}
                    onChange={(e) => loadViewerUpcomingShifts(e.target.value)}
                  >
                    <option value="">Select a name</option>
                    {(isAdmin ? employees : staffDirectory)
                      .filter((employee) => employee.active !== false)
                      .sort((a, b) =>
                        (a.displayName || "").localeCompare(b.displayName || "")
                      )
                      .map((employee) => (
                        <option key={employee.id} value={employee.id}>
                          {employee.displayName}
                        </option>
                      ))}
                  </select>
                </label>
              )}

              {hasPersonalUpcomingShifts && !linkedEmployeeId ? (
                <p className="viewer-shifts-status">
                  This account has not yet been linked to an Employee Register record.
                  Ask an administrator to link the account.
                </p>
              ) : viewerUpcomingShiftsLoading ? (
                <p className="viewer-shifts-status">Loading shifts...</p>
              ) : viewerEmployeeId ? (
                <>
                  {viewerUpcomingShifts.length === 0 ? (
                    <p className="viewer-shifts-status">
                      No upcoming shifts found on the available rotas.
                    </p>
                  ) : (
                    <div className="viewer-shift-list">
                      {viewerUpcomingShifts.map((item, index) => (
                        <article
                          className="viewer-shift-item"
                          key={`upcoming-${item.date}-${item.shift}-${index}`}
                        >
                          <div className="viewer-shift-date">
                            <strong>
                              {new Date(`${item.date}T12:00:00`).toLocaleDateString("en-GB", {
                                weekday: "short",
                                day: "numeric",
                                month: "short",
                                year: "numeric",
                              })}
                            </strong>
                          </div>
                          <div className="viewer-shift-details">
                            <span className="viewer-shift-name">
                              {item.shift.replace("\n", " ")}
                            </span>
                            {item.note && (
                              <span className="viewer-shift-note">{item.note}</span>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}

                  {viewerPreviousShifts.length > 0 && (
                    <button
                      type="button"
                      className="annual-leave-history-toggle upcoming-shifts-history-toggle"
                      onClick={() => setShowPreviousShifts((current) => !current)}
                    >
                      {showPreviousShifts
                        ? "Hide Previous Shifts"
                        : `Show Previous Shifts (${viewerPreviousShifts.length})`}
                    </button>
                  )}

                  {showPreviousShifts && viewerPreviousShifts.length > 0 && (
                    <div className="viewer-shift-list previous-shifts-list">
                      {viewerPreviousShifts.map((item, index) => (
                        <article
                          className={`viewer-shift-item ${index === 0 ? "previous-shifts-first" : ""}`}
                          key={`previous-${item.date}-${item.shift}-${index}`}
                        >
                          <div className="viewer-shift-date">
                            <strong>
                              {new Date(`${item.date}T12:00:00`).toLocaleDateString("en-GB", {
                                weekday: "short",
                                day: "numeric",
                                month: "short",
                                year: "numeric",
                              })}
                            </strong>
                          </div>
                          <div className="viewer-shift-details">
                            <span className="viewer-shift-name">
                              {item.shift.replace("\n", " ")}
                            </span>
                            {item.note && (
                              <span className="viewer-shift-note">{item.note}</span>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </aside>
        </>
      )}

      {(adminView === "weekly" || adminView === "base" || adminView === "payroll") && annualLeaveSidebarOpen && (
        <>
          <div
            className="annual-leave-sidebar-backdrop"
            onClick={() => { setAnnualLeaveSidebarOpen(false); setAllowRetrospectiveAnnualLeave(false); }}
          />
          <aside className="annual-leave-sidebar" aria-label="Annual leave">
            <div className="annual-leave-sidebar-header">
              <div>
                <h2>Annual Leave</h2>
                <p>Upcoming reminders</p>
              </div>
              <button
                type="button"
                className="annual-leave-close"
                onClick={() => { setAnnualLeaveSidebarOpen(false); setAllowRetrospectiveAnnualLeave(false); }}
                aria-label="Close annual leave sidebar"
              >
                ×
              </button>
            </div>

            <div className="annual-leave-sidebar-content">
              {annualLeaveLoading ? (
                <p>Loading annual leave...</p>
              ) : displayedAnnualLeave.length === 0 ? (
                <p className="annual-leave-empty">No annual leave records to show.</p>
              ) : (
                <div className="annual-leave-list">
                  {displayedAnnualLeave.map((leave) => (
                    <article
                      className={`annual-leave-item ${showPastAnnualLeave && upcomingAnnualLeave.length > 0 && leave.id === pastAnnualLeave[0]?.id ? "annual-leave-history-first" : ""}`}
                      key={leave.id}
                    >
                      <div className="annual-leave-item-heading">
                        <strong>{leave.staffName}</strong>
                        {isEditor && (
                          <div className="annual-leave-item-actions">
                            <button
                              type="button"
                              className="annual-leave-edit"
                              onClick={() => editAnnualLeaveReminder(leave)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="annual-leave-delete"
                              onClick={() => deleteAnnualLeaveReminder(leave.id)}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                      <div>
                        {formatAnnualLeaveDate(leave.startDate)}
                        {leave.endDate !== leave.startDate &&
                          ` – ${formatAnnualLeaveDate(leave.endDate)}`}
                      </div>
                      {isEditor && Number.isFinite(Number(leave.leaveHours)) && (
                        <div className="annual-leave-item-hours">Paid A/L: <strong>{Number(leave.leaveHours)}h</strong></div>
                      )}
                      {leave.note && <div className="annual-leave-item-note">{leave.note}</div>}
                    </article>
                  ))}
                </div>
              )}

              {pastAnnualLeave.length > 0 && (
                <button
                  type="button"
                  className="annual-leave-history-toggle"
                  onClick={() => setShowPastAnnualLeave((current) => !current)}
                >
                  {showPastAnnualLeave ? "Hide Past A/L" : `Show Past A/L (${pastAnnualLeave.length})`}
                </button>
              )}

              {isEditor && (
                <form className="annual-leave-form" onSubmit={saveAnnualLeaveReminder}>
                  <h3>{editingAnnualLeaveId ? "Edit Annual Leave" : "Add Annual Leave"}</h3>
                  {isAdmin && !editingAnnualLeaveId && (
                    <label className="annual-leave-retrospective-toggle">
                      <input
                        type="checkbox"
                        checked={allowRetrospectiveAnnualLeave}
                        onChange={(e) => setAllowRetrospectiveAnnualLeave(e.target.checked)}
                      />
                      <span>
                        <strong>Allow retrospective A/L</strong>
                        <small>Permit dates before today for this entry only.</small>
                      </span>
                    </label>
                  )}

                  <RotaStaffPicker
                    label="Staff Name"
                    employees={isAdmin ? employees : staffDirectory}
                    value={annualLeaveName ? [annualLeaveName] : []}
                    onChange={(staff) => setAnnualLeaveName(staff[0] || "")}
                    maxSelected={1}
                    disabled={loadStatus.employees !== "ready"}
                  />
                  {loadStatus.employees !== "ready" && <small>Employee register is not yet available. Retry its loading before selecting staff.</small>}

                  <div className="annual-leave-date-grid">
                    <label>
                      Start Date
                      <input
                        type="date"
                        min={editingAnnualLeaveId || (isAdmin && allowRetrospectiveAnnualLeave) ? undefined : todayId}
                        value={annualLeaveStartDate}
                        onChange={(e) => {
                          const value = e.target.value;
                          setAnnualLeaveStartDate(value);
                          setAnnualLeaveHoursByDate({});
                          setAnnualLeaveSuggestionDetails({});
                          if (!annualLeaveEndDate || annualLeaveEndDate < value) {
                            setAnnualLeaveEndDate(value);
                          }
                        }}
                      />
                    </label>

                    <label>
                      End Date
                      <input
                        type="date"
                        min={annualLeaveStartDate || undefined}
                        value={annualLeaveEndDate}
                        onChange={(e) => {
                          setAnnualLeaveEndDate(e.target.value);
                          setAnnualLeaveHoursByDate({});
                          setAnnualLeaveSuggestionDetails({});
                        }}
                      />
                    </label>
                  </div>


                  {annualLeaveStartDate && annualLeaveEndDate && annualLeaveEndDate >= annualLeaveStartDate && (
                    <div className="annual-leave-hours-panel">
                      <div className="annual-leave-hours-heading">
                        <div>
                          <strong>Paid A/L Hours</strong>
                          <span>Confirm the payroll hours for each date. The app compares the final/resolved rota with the base pattern and avoids guessing when they conflict.</span>
                        </div>
                        <button type="button" onClick={suggestAnnualLeaveHours} disabled={annualLeaveHoursLoading}>
                          {annualLeaveHoursLoading ? "Comparing…" : "Compare Rota Sources"}
                        </button>
                      </div>
                      <div className="annual-leave-hours-list">
                        {getAnnualLeaveDateIds().map((dateId) => (
                          <label key={dateId} className="annual-leave-hours-row">
                            <span>{parseLocalDate(dateId).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "numeric", year: "numeric" })}</span>
                            <input
                              type="number"
                              min="0"
                              step="0.25"
                              value={annualLeaveHoursByDate[dateId] ?? ""}
                              onChange={(e) => setAnnualLeaveHoursByDate((current) => ({ ...current, [dateId]: e.target.value }))}
                              placeholder="0"
                            />
                            <span>hours</span>
                            {annualLeaveSuggestionDetails[dateId] && (
                              <span className={`annual-leave-hours-evidence ${annualLeaveSuggestionDetails[dateId].review ? "review" : ""}`}>
                                Base: {annualLeaveSuggestionDetails[dateId].baseHours}h · Final: {annualLeaveSuggestionDetails[dateId].finalHours === null ? "unavailable" : `${annualLeaveSuggestionDetails[dateId].finalHours}h`} · {annualLeaveSuggestionDetails[dateId].status}
                              </span>
                            )}
                          </label>
                        ))}
                      </div>
                      <div className="annual-leave-hours-total">
                        Total paid A/L: <strong>{getAnnualLeaveDateIds().reduce((sum, dateId) => sum + Number(annualLeaveHoursByDate[dateId] || 0), 0)}h</strong>
                      </div>
                    </div>
                  )}

                  <label>
                    Note <span className="optional-text">(optional)</span>
                    <input
                      value={annualLeaveNote}
                      onChange={(e) => setAnnualLeaveNote(e.target.value)}
                      placeholder="e.g. Approved A/L"
                    />
                  </label>

                  <button type="submit" className="annual-leave-save">
                    {editingAnnualLeaveId ? "Save A/L Changes" : "Add Reminder"}
                  </button>
                  {editingAnnualLeaveId && (
                    <button type="button" className="annual-leave-cancel-edit" onClick={clearAnnualLeaveForm}>
                      Cancel Edit
                    </button>
                  )}
                </form>
              )}
            </div>
          </aside>
        </>
      )}

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