# LC Rota

A secure, role-based staffing rota web application developed for a residential care setting. LC Rota replaces manually maintained and printed rotas with a centralised weekly schedule, controlled editing, staff-specific views and administrative tools.

> **Private workplace application.** This repository contains application code, not a public rota service. Access to deployed features requires an authorised account. Do not commit resident information, employee records, credentials, service-account keys or exported payroll/audit data.

## Features

- **Weekly rota:** Monday–Sunday schedule with day and night shifts, assigned staff, vacant slots and shift notes.
- **Staff accounts:** authenticated access with role-based permissions; individual staff can view their own upcoming shifts.
- **Rota editing:** authorised senior staff and administrators can amend assignments and vacancies.
- **Base rota:** versioned templates, including optional two-week patterns and effective dates.
- **Scheduled rota:** prepare future weeks as drafts and publish them when appropriate.
- **Annual leave and sickness:** record absences and support rota/payroll reconciliation.
- **Staff administration:** employee register, contracted-hours history and account management.
- **Payroll support:** calculate worked hours, adjustments and actual-hours overrides; provide payroll summaries and exports.
- **Archives:** retain older rota and staffing information for authorised review.
- **Audit history:** record selected changes to operational data with before/after values and the acting account. Day-note edits and read-only access are not intended to be logged.
- **Responsive layout:** desktop and mobile rota views, with print support.

Some functions and views are restricted by account role. Features are subject to ongoing development and testing.

## Technology

| Layer | Technology |
| --- | --- |
| Front end | React, Vite, JavaScript, CSS |
| Authentication | Firebase Authentication |
| Database | Cloud Firestore |
| Hosting | Netlify |
| Server-side account operations | Netlify Functions |
| PDF generation | jsPDF and jspdf-autotable |

## Access and security

- Firebase Authentication handles sign-in.
- Firestore Security Rules enforce data access independently of which controls the interface displays.
- Staff have restricted, primarily read-only access; seniors can edit permitted rota and leave data; administrators manage additional staffing and payroll functions.
- Account creation and privileged account operations use a server-side Netlify Function.
- Audit records are intended to be append-only for application users, with viewing restricted to administrators.

**Audit limitation:** the current audit mechanism is initiated by the client application. It is useful for operational traceability, but it is **not a tamper-proof, server-enforced audit trail**: an otherwise authorised direct Firestore write may bypass the client logger. Do not describe the app as independently certified or fully compliant with any regulatory standard on the basis of this feature alone.

### Data protection

The application handles identifiable workforce and payroll information. Follow the organisation's applicable data-protection, retention, access-control and incident-response procedures. Avoid using real personal information in test data, screenshots, GitHub issues or pull requests.

## Development notes

- Review the Firestore rules whenever adding a new collection, document field or audited write.
- Keep audit entries and the associated operational change consistent; investigate any permission errors before deploying.
- Test changes under staff, senior and administrator accounts rather than relying on administrator testing alone.
- Avoid committing `.env` files containing secrets, Firebase Admin service-account files or exported database data.

## Project status

Actively developed for internal workplace use. Functionality and implementation details may change as the rota, payroll and audit workflows are refined.

## Licence

No open-source licence is granted by this README. Unless the repository contains a separate licence file, the code should be treated as **all rights reserved**.
