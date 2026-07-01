const fs = require('fs');
const path = require('path');

const STORAGE_FILE = path.join(__dirname, 'tokens.json');

function loadStorage() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      return JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('[Storage] Load error:', error.message);
  }
  return {};
}

function saveStorage(data) {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[Storage] Save error:', error.message);
  }
}

function getToken(userId) {
  const data = loadStorage();
  return data[userId] || null;
}

function setToken(userId, token) {
  const data = loadStorage();
  data[userId] = token;
  saveStorage(data);
}

function deleteToken(userId) {
  const data = loadStorage();
  delete data[userId];
  saveStorage(data);
}

module.exports = { getToken, setToken, deleteToken, loadStorage };
