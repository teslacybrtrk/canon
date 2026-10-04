Goal: vendors want to reserve a stall for a market day. Make this fact true:
"A stall cannot be double-booked."
The fact file is claims/no-double-booking.json. Add POST /api/reservations
({stallId, date, name}) returning 201, and 409 when that stall is already booked that date.
Declare it, implement it, push, read the verdict.
