import datetime


def format_ts(ts):
    """Format a unix timestamp for report headers."""
    return datetime.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def today_str():
    return datetime.date.today().isoformat()
