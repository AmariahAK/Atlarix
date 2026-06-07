def dedupe_orders(orders):
    """Drop duplicate orders by id, keeping the first occurrence."""
    seen = set()
    out = []
    for order in orders:
        if order["id"] in seen:
            continue
        seen.add(order["id"])
        out.append(order)
    return out


def order_key(order):
    return order["id"]
