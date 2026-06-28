import sqlite3
db = sqlite3.connect("C:/repos/http_proxy/data/artifacts.db")

print("=== Sessions by user ===")
for row in db.execute("SELECT user_id, COUNT(*) as n FROM session GROUP BY user_id"):
    print(f"  user_id={row[0]}: {row[1]} sessions")

print("\n=== Artifacts by user (via session) ===")
for row in db.execute("""
    SELECT s.user_id, COUNT(*) as n 
    FROM artifact a JOIN session s ON a.session_id = s.id 
    GROUP BY s.user_id
"""):
    print(f"  user_id={row[0]}: {row[1]} artifacts")

print("\n=== Categories ===")
for row in db.execute("SELECT id, name FROM category"):
    print(f"  {row[0]}: {row[1]}")

print("\n=== Subjects ===")
for row in db.execute("SELECT id, name, category_id FROM subject"):
    print(f"  {row[0]}: {row[1]} (category={row[2]})")

print("\n=== Roles by user ===")
for row in db.execute("""
    SELECT s.user_id, a.role, COUNT(*) as n 
    FROM artifact a JOIN session s ON a.session_id = s.id 
    GROUP BY s.user_id, a.role ORDER BY s.user_id, n DESC
"""):
    print(f"  user={row[0]}, role={row[1]}: {row[2]}")

db.close()