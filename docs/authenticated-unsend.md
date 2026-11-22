# Authenticated Unsend

Real accounts use the existing sender-authorized `DELETE /api/messages/:storageId` route.
The UI uses the encrypted envelope's wire `id`; `AuthenticatedUnsend` resolves the route
from the loaded message's separate `storageId`. Session cookies, CSRF, conversation access,
and sender ownership remain enforced by DATA. No new deletion endpoint is provided.

The combined DATA/realtime process (`server`: `npm run start:data`) observes DATA's own
successful tombstone response after the mutation committed. It emits the server-only hint
`message:deleted` with exactly `{ conversationId, messageId }`, where `messageId` is the
wire ID. Every recipient is checked through the existing `mayReceive` authorization path.
Client-originated events with this name cannot perform deletion.

Hints are not proof of deletion. The authenticated client fetches authorized history,
including older pages when necessary, before merging the tombstone. Reconnect also
refreshes the loaded history window to recover missed events. Tombstones keep their wire
identity, sequence and sender metadata and cannot be replaced by delayed active rows.
The sender confirms the API response or reconciles a lost response through history;
in-flight confirmations share one request and do not retry DELETE automatically.

Delete for Me stays in account/conversation-scoped browser preferences and emits no server
mutation. Its confirmation is separate from Unsend. Other messages' encrypted reply and
forward payloads are unchanged; references to an unsent original show its unavailable/deleted state.

Notifications are process-local, like the existing DATA change hints. Multiple independently
served realtime instances need shared notification infrastructure; authorized history is durable.
