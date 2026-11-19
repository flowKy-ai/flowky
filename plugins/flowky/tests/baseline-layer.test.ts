// The baseline layer (hooks driven with an in-memory Io), in ONE test child.
//
// `claude plugin test` starts one child process per *.test.ts file, all at the same time, and each
// child commits several hundred MB of memory while it loads this code; on a machine short of commit
// memory a child then dies while loading ("its run ended without a report (exit code 9)"). The
// tests are therefore *.suite.ts modules, grouped by layer in two files, as in FlowKy Pro;
// tests-node/suites.test.mjs checks that every suite is imported by exactly one group.

import './baseline.suite'
import './hardening-shared.suite'
import './migration.suite'
