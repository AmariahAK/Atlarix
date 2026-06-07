def aggregate_totals(orders):
    """Sum order totals per currency."""
    total = 0
    for order in orders:
        total += order.get("total", 0)
    return {"USD": total}


def average_total(orders):
    totals = aggregate_totals(orders)
    return totals["USD"] / max(1, len(orders))
