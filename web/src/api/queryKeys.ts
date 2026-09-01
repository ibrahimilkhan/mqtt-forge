export const queryKeys = {
  connection: ['connection'] as const,
  savedSettings: ['connection', 'settings'] as const,
  reconnect: ['connection', 'reconnect'] as const,
  savedProfiles: ['connection', 'profiles'] as const,
  subscriptions: ['subscriptions'] as const,
  colourRules: ['colour-rules'] as const,
  alertRules: ['alert-rules'] as const,
  exportFolder: ['export', 'folder'] as const,
  certificateDialog: ['connection', 'certificate-file'] as const,
};
