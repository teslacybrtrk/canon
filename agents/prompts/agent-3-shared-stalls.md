Goal: the market manager wants co-op stalls, where two small vendors share one stall on the same day.
Make this fact true: "Two vendors can share a stall on the same market day."
The fact file is claims/stalls-can-be-shared.json. Add POST /api/reservations ({stallId, date, name})
returning 201 Created, and GET /api/reservations?stallId=&date= listing who booked it
(the rehearsal reads bookings back with it). Declare it, implement it, push, read the verdict.
