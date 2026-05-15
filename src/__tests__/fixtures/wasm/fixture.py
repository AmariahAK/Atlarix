from fastapi import APIRouter

router = APIRouter()

@router.get("/items")
def list_items():
    return []

class UserService:
    def find(self, user_id: str):
        return user_id
