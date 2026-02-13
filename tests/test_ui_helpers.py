from app.ui_dpg import to_state_color


def test_to_state_color_on_off_value():
    assert to_state_color("ON") == (30, 180, 80, 255)
    assert to_state_color("OFF") == (210, 60, 60, 255)
    assert to_state_color("123") == (180, 180, 180, 255)
