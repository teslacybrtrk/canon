Goal: after market, each vendor is paid for the lines it sold, so the basket must say who sold each line.
Make this fact true: "Every basket line says which stall it comes from."
The fact file is claims/line-names-stall.json. Declare it, implement it, push, read the verdict.
If it is already claimed, another agent wants the same fact for its own reasons: join it with
canon claim --join line-names-stall --why "<why it matters to you>". A fact an agent proposes lands only
once a second agent makes it true independently.
