const { listNotes, createNote } = require("./src/note/repository.js");
const { NoteService } = require("./src/note/service.js");

const service = new NoteService({ createNote, listNotes });
const created = service.create("first note");
const notes = service.list();
if (notes.length !== 1 || notes[0].text !== "first note") {
  console.error(`E2E failed: expected [first note] but got ${JSON.stringify(notes)}`);
  process.exit(1);
}
if (created.text !== "first note" || typeof created.id !== "string") {
  console.error("create returned invalid shape");
  process.exit(1);
}
console.log("data management e2e passed");
