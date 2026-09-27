// SupportOS desktop shell entry point. All logic lives in lib.rs so the same
// code could back a mobile target later (not currently shipped).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    supportos_lib::run();
}
