from worker.report.aggregate import aggregate_totals


def build_daily_report(orders):
    """Build the end-of-day sales report."""
    totals = aggregate_totals(orders)
    return {"date": "today", "totals": totals}


def report_subject(report):
    return "Daily report " + report["date"]
