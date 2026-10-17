// Inställningar för dagboken. Se README.md för hur du tar fram Client ID.
window.DIARY_CONFIG = {
  // OAuth Client ID från Google Cloud Console (inte hemligt, får ligga publikt).
  clientId: '445785278839-04pen59t10l5qior1rqtuv84rni5buee.apps.googleusercontent.com',

  // Lämna tomt så frågar sidan efter länken till kalkylarket första gången
  // och sparar den bara i telefonen. Då hamnar den aldrig på GitHub.
  spreadsheetId: '',

  // Namnet som visas överst på sidan.
  title: 'Dagboken'
};
