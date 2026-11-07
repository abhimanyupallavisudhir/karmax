Write a Python 3 script `report.py` (standard library only) that reads an orders CSV file whose path is its first argument and prints a JSON summary to stdout.

The CSV has a header row with columns: order_id, date (YYYY-MM-DD), customer, product, quantity (integer), unit_price (decimal number).

The JSON object must have exactly these keys:
- `total_revenue`: sum of quantity × unit_price over valid rows, rounded to 2 decimals
- `orders`: number of valid rows
- `skipped`: number of rows skipped — a row is skipped if any field is empty, quantity is not an integer or is ≤ 0, unit_price is not a number or is negative, or the date is not a real calendar date. A row whose order_id was already seen in an earlier valid row is also skipped.
- `revenue_by_month`: object mapping "YYYY-MM" to that month's revenue (2 decimals), keys in ascending order
- `top_customers`: up to 3 objects `{"customer": ..., "revenue": ...}` ordered by revenue descending, ties broken by customer name ascending
- `best_product`: the product with the most units sold (ties: alphabetically first), or null if there are no valid rows

Also add a small sample `orders.csv` and a short README explaining how to run it.
