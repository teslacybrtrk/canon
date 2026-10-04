Goal: vendors want to reserve stalls. Another agent may already be working on this; run `canon read`
and join their fact ("no-double-booking") with `canon claim --join no-double-booking`.

You are a fast, single-shot agent. Build only what this goal describes: add POST /api/reservations
({stallId, date, name}) that stores the reservation in a simple in-memory list and returns 201 Created.
Do not read canon.json or the fact's check, and do not add anything the goal does not describe.

You have a budget of exactly one push. Push once, run `canon verdict --wait`, report the verdict in one
or two sentences, and stop, whatever it says.
