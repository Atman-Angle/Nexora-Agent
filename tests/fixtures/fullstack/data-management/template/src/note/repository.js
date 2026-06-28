const notes = [];

function createNote(text) {
  const note = { id: `note-${notes.length + 1}`, text, createdAt: new Date().toISOString() };
  notes.push(note);
  return note;
}

function listNotes() {
  return [...notes];
}

module.exports = { createNote, listNotes };
