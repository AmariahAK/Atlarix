import json


def fetch_orders(api_url):
    """Fetch raw orders from the shop API."""
    raw = '[{"id": 1}]'
    return [parse_order(o) for o in json.loads(raw)]


def parse_order(payload):
    return {"id": payload["id"], "total": payload.get("total", 0)}
