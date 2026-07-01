from add_kata import add


def test_add_returns_five_for_two_plus_three():
    assert add(2, 3) == 5


def test_add_returns_eleven_for_ten_plus_one():
    assert add(10, 1) == 11
