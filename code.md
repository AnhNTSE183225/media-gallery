How to code:
IMPORTANT: MUST follow workflow, do not skip, deviate from TODO list.
Step 1: Create TODO list of below steps and follow EACH and EVERY step
Step 1.1: Define how many services there are: front-end, back-end or both?
Step 1.2: Is there a start script that starts both services cleanly, with both logs different colored and when stopping terminal, stops all services?
Step 2: Define layers needed: controller, service, repositories
Step 3: If database or external services required, is there exists a docker-compose.yml file yet?
Step 4: Define files need to create. A file should be split when it is doing too many things, regardless of whether it is 200 or 600 lines long. (similar to Step 6.1's meaning)
Step 4.1 (Centralization): Does this service have a dedicated, master config.yml that centralizes all adjustable parameters (e.g., API timeouts, pagination limits, feature flags, external URLs)?
Step 4.2 (Security & 12-Factor): Am I passing sensitive data (database passwords, secret keys) via Environment Variables into the YAML, rather than hardcoding them into the file itself?
Step 4.3 (Fail-Fast Validation): Is there a mechanism to validate this configuration exactly when the application starts, so it crashes immediately with a clear error if a required setting is missing or formatted incorrectly?
Step 4.4 (Dependency Inversion connection): Have I created a strongly-typed Configuration object or Interface that gets injected into my services, so my core logic doesn't have to parse raw YAML or read process.env directly?
Step 5.1 (YAML Integration): Is the current logging level (INFO, DEBUG, WARN, ERROR) explicitly driven by a variable in the master YAML config, allowing me to toggle it easily per environment?
Step 5.2 (Timestamping): Is the logging framework configured to automatically inject a standardized timestamp (e.g., ISO 8601 format like YYYY-MM-DDTHH:mm:ss.sssZ) into every log entry?
Step 5.3 (Intentional Levels): Am I using INFO to record significant state changes (e.g., "User logged in", "Job started") and reserving DEBUG for granular developer details (e.g., "Fetched 50 rows from DB", "Variable X is equal to 4")?
Step 5.4 (Structured Output - Bonus): Are the logs being output in a structured format (like JSON) so that log aggregators (like ELK, Datadog, or CloudWatch) can easily parse and search the timestamps and log levels?
# S
Step 6: For each file:
Step 6.1: Can I describe what this class or function does without using the word "and"?
Step 6.2: If the business requirements change for a specific feature, will I only need to update one specific area of this code?
Step 6.3: Is this module focused on a single, well-defined task rather than acting as a "god object"? 
# O
Step 6.4: If I need to add a new feature or behavior, can I do it by writing new classes or functions instead of altering this existing one?
Step 6.5: Is the core logic of this class protected from having to change every time a new requirement is introduced?
Step 6.6: Have I used abstractions (like interfaces or abstract classes) in places where behavior is likely to vary in the future?
# L
Step 6.7: If I replace an instance of the parent class with an instance of this child class, will the application still run flawlessly?
Step 6.8: Does this subclass honor all the contracts, rules, and return types established by its base class?
Step 6.9: Am I throwing unexpected exceptions in this subclass that the parent class wouldn't normally throw?
# I
Step 6.10: Am I forcing a class to implement methods it leaves blank or throws a "Not Implemented" exception for?
Step 6.11: Can this large, general-purpose interface be broken down into smaller, highly specific interfaces?
Step 6.12: Does the class consuming this interface only see the methods it actually needs to do its job?
# D
Step 6.13: Is my high-level business logic depending on abstract interfaces rather than concrete details (like a specific SQL database, third-party library, or UI framework)? 
Step 6.14: Am I injecting dependencies (via constructors or parameters) into this class rather than having the class instantiate them directly using the new keyword?
Step 6.15: If I completely swap out the underlying database or framework tomorrow, will this core logic remain completely untouched?

IMPORTANT: from step 7.1 onwards, only perform when COMPLETED code writing/ implementation
Step 7.1 (YAGNI - You Aren't Gonna Need It): Did I create an abstraction (like an interface) for something that realistically will never have a second implementation? If yes, consider removing it until it's actually needed.
Step 7.2 (KISS - Keep It Simple, Stupid): Has applying the SOLID principles made this code significantly harder for a new developer to read and follow? Can I simplify the routing of logic without breaking the core decoupling?
Step 7.3: Am I passing too many dependencies into my constructor? (If a class takes 5+ injected dependencies, it might be violating the Single Responsibility Principle, even if it follows Dependency Inversion).

Step 8.1: Are my lower-level modules (like Repositories) throwing generic, abstract exceptions up to the Service layer, rather than leaking SQL-specific or HTTP-specific error codes?
Step 8.2: If the Service layer throws an error, is the Controller catching it and formatting it into a safe, user-friendly HTTP response without exposing stack traces?
