Make me a small web app for splitting group expenses on a trip. It should be a single `index.html` (CSS and JavaScript inline or in files next to it, no build step, nothing loaded from the internet) that works when opened directly from disk.

What it needs (please use exactly these element ids — I have automated checks that rely on them):
- `#person-name` text input and `#add-person` button: adds a person. Ignore empty names (after trimming) and names already added.
- `#payer` select listing the people, `#amount` number input, `#description` text input and `#add-expense` button: records an expense paid by the selected person, split equally among everyone added so far. Ignore an amount that is empty, zero or negative.
- `#balances`: a list with one `<li data-person="NAME">` per person whose text includes their balance formatted with a sign and two decimals, e.g. `+12.50`, `-7.25` or `0.00` (positive means they are owed money).
- `#settle` button: fills `#transfers` with one `<li>` per payment needed to settle up, each reading exactly like `Alice pays Bob 12.50`. Compute them by repeatedly having the person who owes the most pay the person who is owed the most, as much as possible, until everyone is at zero.
- `#reset` button: clears everything.
- Everything is saved in localStorage so a page reload keeps the people and expenses.

Make it look nice and work on a phone too.
