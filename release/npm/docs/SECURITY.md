# Security notes for testers

- Treat this alpha as software that can run commands as you. Use a disposable or backed-up repository.
- Never put a production key, a customer's data or a repository you cannot restore into an alpha session.
- Bashwink never writes your provider key to its config; it reads the named environment variable or key file when it runs.
  Keep a key file readable only by you.
- Report a vulnerability privately to the person who sent you this package. Do not post details publicly.
- You do not need to turn off any operating-system protection (Gatekeeper, SmartScreen, antivirus, firewall) to use
  this package, and you should not. If something asks you to, stop and report it.
