extends CharacterBody3D
## Testbed player: moves forward on "move_forward"; on "jump" emits `jumped` and raises a
## deliberate push_error so the harness can prove runtime-errors-get captures in-game faults.

signal jumped

func _physics_process(_delta: float) -> void:
	var dir := Vector3.ZERO
	if Input.is_action_pressed("move_forward"):
		dir.z -= 1.0
	velocity = dir * 5.0
	move_and_slide()
	if Input.is_action_just_pressed("jump"):
		jumped.emit()
		push_error("modulex-qa: deliberate jump error")
