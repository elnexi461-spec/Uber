---
name: Workspace routing
description: Replit artifact proxy behavior for mixed legacy and root services
---

More-specific artifact service paths take precedence over a root web service, even when the more-specific workflow is stopped. A stopped scaffold route can therefore produce proxy 502s before the root app receives the request.

**Why:** The imported dashboard served `/api/*` correctly on its own, but the pre-existing `/api` artifact route intercepted those requests and returned 502 while its workflow was not running.

**How to apply:** When importing an app into a workspace with existing artifacts, inspect every artifact service `paths` entry before testing. Move unused legacy paths away from the product's API prefix using the validated artifact configuration flow.