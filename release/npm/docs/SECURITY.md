# Security notes for testers

- Treat this alpha as software that can run commands as you. Use a disposable or backed-up repository.
- Never put a production key, a customer's data or a repository you cannot restore into an alpha session.
- Bashwink never writes your provider key to its config; it reads the named environment variable or key file when it runs.
  Keep a key file readable only by you. With a **key file**, the model's file tools cannot read it (reads outside the project are
  refused) and a shell command's obvious path arguments outside the project are refused too. That shell check is
  best-effort, not a sandbox: a command you approve that builds a path indirectly could still read the file. With an **environment variable**, Bashwink removes that variable from shell commands it runs and masks its
  value in the evidence log, but other tools you run yourself in the same environment can still see it; a key file is the
  safer choice. On Windows, file permissions are not checked by Bashwink; keep the key file in your user profile.
- Set a spending limit at your provider. Bashwink's own limits stop new requests but are not a hard ceiling.
- Report a vulnerability privately to the person who sent you this package. Do not post details publicly.
- You do not need to turn off any operating-system protection (Gatekeeper, SmartScreen, antivirus, firewall) to use
  this package, and you should not. If something asks you to, stop and report it.
