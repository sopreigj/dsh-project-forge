# Initialize a project with Project Forge Mode

Turns an ordinary directory into a project the mode can take over: it creates the state boundary
`private/`, the four contract documents, and the `.gitignore` line the concurrent-write claims
need. Run it once per project.

## Steps

1. In the project you want to bring under the mode:

   ```sh
   node <path-to-this-bundle>/release/init-project.mjs
   ```

   Pass a path to initialize somewhere else: `node release/init-project.mjs ../my-project`.

2. Review the four documents it wrote. They are the project's state, and the mode sends them to
   every session: `private/steward.md` (this project's own rules and vocabulary),
   `private/plan.md` (goal, current direction, phases), `private/done.md` (verification,
   drift, current state), `private/todo.md` (the queue).

3. `git init` if the project has no repository yet, then choose the mode for a new session.

Running the initializer again is safe: it never overwrites a file that exists and prints what it
left alone. A project that already keeps its documents at the project root keeps working
unchanged — the mode falls back to the older layout.
