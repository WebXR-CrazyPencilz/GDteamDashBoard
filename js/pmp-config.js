/**
 * PMP — Config
 * Standalone project. Do not point this at the TimeTrack backend.
 */

const PMP_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbxsiRP0kAMdm42T3tZHqIqJxSroVKQ3o5kfghRzS_yVVwKEwrnmG0Xi6qHw9YUbqzLw/exec',

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
    ADMIN: 'Admin'
  },

  

  // Employee / TeamLead / Manager are flat, equal-tier roles under Admin.
  // There is no reporting relationship between TeamLead and Employee — any
  // Team Lead can assign work to any active Employee. Employees do not
  // belong to a fixed team.
  ALL_ROLES: ['Employee', 'Manager', 'TeamLead', 'Admin'],

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