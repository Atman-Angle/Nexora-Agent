from src.math import add

if add(2, 3) != 5:
    print(f"Expected 5 but got {add(2, 3)}")
    raise SystemExit(1)

if add(0, 0) != 0:
    raise SystemExit(1)

print("python math test passed")
