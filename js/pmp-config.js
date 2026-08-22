/**
 * PMP — Config
 * Standalone project. Do not point this at the TimeTrack backend.
 */

const PMP_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbxc1D1sgDR45G9o4Du7cfzWhpzls5bdmJ5QRauTtx5IAo8ZAYkpGa1y_mrhH26LfOZH/exec',

  // No "Accepted" state — employees never accept work, they start it. First
  // "Start Work" click auto-transitions Assigned -> Working.
  STATUS_FLOW: ['Assigned', 'Working', 'Review', 'Completed', 'Closed'],

  STATUS_COLORS: {
    Assigned: 'var(--status-assigned)',
    Working: 'var(--status-working)',
    Review: 'var(--status-review)',
    Completed: 'var(--status-completed)',
    Closed: 'var(--status-closed)'
  },

  PRIORITIES: ['Low', 'Medium', 'High'],

  ROLES: {
    EMPLOYEE: 'Employee',
    MANAGER: 'Manager',
    TEAM_LEAD: 'TeamLead',
    ADMIN: 'Admin',
    // HR — a REAL role, stored as a normal row in the Employees sheet
    // (Role = 'HR'), authenticated through the exact same pmp_login as
    // Employee/Manager/TeamLead. No ghost account, no hardcoded
    // credentials. Routes to the read-only HR Portal (PmpHR / pmp-hr.js)
    // in index.html's routeToPortal switch.
    HR: 'HR'
  },

  

  // Employee / TeamLead / Manager / HR are flat, equal-tier roles under
  // Admin. There is no reporting relationship between TeamLead and
  // Employee — any Team Lead can assign work to any active Employee.
  // Employees do not belong to a fixed team.
  //
  // Admin stays the ONE ghost-only role — it's still listed here (the
  // People panel's Role dropdown shows it) but the backend rejects
  // creating/editing an Admin row regardless (see
  // pmp_createEmployee/pmp_updateEmployee in Code.gs). HR is NOT ghost —
  // it's included here so a Manager can create an HR account the normal
  // way, through the existing "+ Add person" flow, same as any other
  // role.
  ALL_ROLES: ['Employee', 'Manager', 'TeamLead', 'Admin', 'HR'],

  // Work Inbox notification types. Only NEW_ASSIGNMENT is fired by the
  // backend today; the rest are reserved so the schema and UI don't need
  // to change shape when they're wired up later.
  NOTIFICATION_TYPES: {
    NEW_ASSIGNMENT: 'NewAssignment',
    REVIEW_REQUEST: 'ReviewRequest',
    REWORK: 'Rework',
    DEADLINE_REMINDER: 'DeadlineReminder',
    COMPLETED_APPROVAL: 'CompletedApproval',
    ANNOUNCEMENT: 'Announcement'
  },

  SESSION_KEY: 'pmp_session'
};