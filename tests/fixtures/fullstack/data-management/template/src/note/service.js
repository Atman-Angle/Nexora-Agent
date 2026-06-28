class NoteService {
  constructor({ createNote, listNotes }) {
    this.createNote = createNote;
    this.listNotes = listNotes;
  }

  create(text) {
    // BUG: does not persist and returns wrong shape
    return { id: null, text: text.toUpperCase() };
  }

  list() {
    // BUG: returns empty instead of persisted notes
    return [];
  }
}

module.exports = { NoteService };
