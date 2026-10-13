Goal: vendors want to reserve a stall for a market day. Make this fact true:
"A stall cannot be double-booked."
The fact file is claims/no-double-booking.json. Add POST /api/reservations
({stallId, date, name}) returning 201, and 409 when that stall is already booked that date, and
GET /api/reservations?stallId=&date= listing who booked it (the rehearsal reads bookings back with it).
Declare it, implement it, push, read the verdict.
