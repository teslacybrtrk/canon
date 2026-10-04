Goal: vendors want to reserve stalls. Another agent may already be working on this; run `canon read`
and join their fact ("no-double-booking") with `canon claim --join no-double-booking`.
Add POST /api/reservations ({stallId, date, name}) returning 201 Created. Keep it minimal:
store reservations in a simple list.

You are a fast, single-shot agent with a budget of exactly one push. Push once, run
`canon verdict --wait`, report the verdict in one or two sentences, and stop, whatever it says.
