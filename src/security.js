function isSafeQuery(queryString) {
  if (process.env.ALLOW_WRITE === 'true') {
    return true;
  }
  
  // Normalize query for simple checking
  const normalized = queryString.trim().toUpperCase();
  
  if (normalized.includes(';')) {
    // Reject multi-statement queries to prevent injection
    const parts = normalized.split(';').filter(part => part.trim().length > 0);
    if (parts.length > 1) {
      return false;
    }
  }

  // Ensure it starts with SELECT
  if (!normalized.startsWith('SELECT')) {
    return false;
  }

  // Blocklist for dangerous keywords
  const blocklist = ['DELETE', 'UPDATE', 'DROP', 'INSERT', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE'];
  for (const keyword of blocklist) {
    const regex = new RegExp(`\\b${keyword}\\b`);
    if (regex.test(normalized)) {
      return false;
    }
  }

  return true;
}

module.exports = {
  isSafeQuery
};
